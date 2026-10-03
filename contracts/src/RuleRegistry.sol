// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {L2Clock} from "./libraries/L2Clock.sol";

/// @title RuleRegistry
/// @notice Which spending wallets feed which investing account, and the rule that
///         turns their payments into spare change.
/// @dev Spec law 1: round-ups come ONLY from wallets the user explicitly links.
///      Linking a wallet other than your own requires that wallet's signature, so
///      nobody can attach a wallet they do not control. Linking is the account's
///      own action — no admin can link or unlink on a user's behalf.
///
///      The rule lives on-chain because it is what makes a keeper's accrual
///      auditable: anyone can read it and recompute the same number from the
///      same public payments.
contract RuleRegistry is EIP712 {
    struct Rule {
        uint8 roundTo; // whole dollars: 1, 5 or 10
        uint8 multiplier; // 1..5
        uint64 weeklyCap; // USDG base units (6 dp); 0 = accrual disabled
        bool enabled;
    }

    uint256 public constant MAX_WALLETS = 8;

    bytes32 public constant LINK_TYPEHASH =
        keccak256("Link(address account,address wallet,uint256 nonce,uint256 deadline)");

    mapping(address account => Rule) internal _rules;
    mapping(address wallet => address account) public accountOf;
    mapping(address account => address[]) internal _wallets;
    /// @notice Per-wallet nonce for link signatures (replay protection).
    mapping(address wallet => uint256) public nonces;
    /// @notice L2 block at which the wallet was (most recently) linked. The
    ///         executor never accrues from before this, so a new link can never
    ///         reach back and pull round-ups for payments made before consent.
    mapping(address wallet => uint256) public linkedAt;
    /// @notice L2 block at which the account's rule last became ACTIVE (enabled
    ///         with a non-zero cap). The executor never accrues from before it, so
    ///         turning round-ups back on never reaches into the paused window.
    mapping(address account => uint256) public activeSince;

    event RuleSet(address indexed account, uint8 roundTo, uint8 multiplier, uint64 weeklyCap, bool enabled);
    event Linked(address indexed account, address indexed wallet);
    event Unlinked(address indexed account, address indexed wallet);
    event NonceInvalidated(address indexed wallet, uint256 newNonce);

    error BadRoundTo(uint8);
    error BadMultiplier(uint8);
    error AlreadyLinked(address wallet, address account);
    error NotLinked(address wallet);
    error TooManyWallets();
    error Expired();
    error BadSignature();

    constructor() EIP712("SPARE RuleRegistry", "1") {}

    // ── rules ──────────────────────────────────────────────────────────────

    function setRule(uint8 roundTo, uint8 multiplier, uint64 weeklyCap, bool enabled) external {
        if (roundTo != 1 && roundTo != 5 && roundTo != 10) revert BadRoundTo(roundTo);
        if (multiplier == 0 || multiplier > 5) revert BadMultiplier(multiplier);
        Rule memory prev = _rules[msg.sender];
        bool wasActive = prev.enabled && prev.weeklyCap != 0;
        bool isActive = enabled && weeklyCap != 0;
        if (isActive && !wasActive) activeSince[msg.sender] = L2Clock.blockNumber();
        _rules[msg.sender] = Rule(roundTo, multiplier, weeklyCap, enabled);
        emit RuleSet(msg.sender, roundTo, multiplier, weeklyCap, enabled);
    }

    function ruleOf(address account) external view returns (Rule memory) {
        return _rules[account];
    }

    // ── linking ────────────────────────────────────────────────────────────

    /// @notice Link the caller's own address as a spending wallet.
    function linkSelf() external {
        _link(msg.sender, msg.sender);
    }

    /// @notice Link another wallet, authorised by that wallet's EIP-712 signature.
    /// @dev SignatureChecker accepts EOA signatures and ERC-1271 smart wallets.
    function linkWallet(address wallet, uint256 deadline, bytes calldata signature) external {
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(LINK_TYPEHASH, msg.sender, wallet, nonces[wallet], deadline))
        );
        if (!SignatureChecker.isValidSignatureNow(wallet, digest, signature)) revert BadSignature();
        _link(msg.sender, wallet); // consumes the nonce
    }

    /// @notice Unlink a wallet. Stops NEW accrual from it immediately; the
    ///         executor refuses to pull from a wallet that is no longer linked.
    ///         Callable by the account OR by the wallet itself — a wallet can
    ///         always withdraw its own consent.
    function unlink(address wallet) external {
        address account = accountOf[wallet];
        if (account == address(0)) revert NotLinked(wallet);
        if (msg.sender != account && msg.sender != wallet) revert NotLinked(wallet);
        delete accountOf[wallet];
        // Any link signature the wallet handed out earlier dies with the link.
        unchecked {
            nonces[wallet]++;
        }
        address[] storage list = _wallets[account];
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == wallet) {
                list[i] = list[list.length - 1];
                list.pop();
                break;
            }
        }
        emit Unlinked(account, wallet);
    }

    /// @notice A wallet kills every outstanding link signature it has signed.
    function invalidateNonce() external {
        uint256 n;
        unchecked {
            n = ++nonces[msg.sender];
        }
        emit NonceInvalidated(msg.sender, n);
    }

    function walletsOf(address account) external view returns (address[] memory) {
        return _wallets[account];
    }

    function isLinked(address account, address wallet) external view returns (bool) {
        return account != address(0) && accountOf[wallet] == account;
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _link(address account, address wallet) internal {
        address existing = accountOf[wallet];
        if (existing != address(0)) revert AlreadyLinked(wallet, existing);
        if (_wallets[account].length >= MAX_WALLETS) revert TooManyWallets();
        accountOf[wallet] = account;
        unchecked {
            nonces[wallet]++;
        }
        linkedAt[wallet] = L2Clock.blockNumber();
        _wallets[account].push(wallet);
        emit Linked(account, wallet);
    }
}
