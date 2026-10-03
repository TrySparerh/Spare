// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SpareAuth} from "./SpareAuth.sol";

/// @title ScreeningGate
/// @notice Eligibility for buying tokenized stocks.
/// @dev Robinhood stock tokens are not offered to US persons and are restricted in
///      further jurisdictions (Canada, UK, Switzerland, …). This gate records which
///      accounts an attestor has cleared, and for how long. It enforces that a
///      clearance EXISTS — it cannot decide who should be cleared. The screening
///      policy, and the evidence behind each attestation, belong to the operator.
///
///      The spec lists ScreeningGate among "reused" privacy-core contracts; none
///      was found, so this is a minimal standalone implementation with the same
///      role. It gates BUYING only: exits and USDG withdrawals never consult it.
contract ScreeningGate is SpareAuth, EIP712 {
    bytes32 public constant CLEARANCE_TYPEHASH =
        keccak256("Clearance(address account,uint64 validUntil,uint256 nonce)");

    address public attestor;
    /// @notice Off on testnets / local forks; on in production.
    bool public enforced;

    mapping(address account => uint64) public clearedUntil;
    mapping(address account => uint256) public nonces;

    event AttestorSet(address indexed attestor);
    event EnforcedSet(bool enforced);
    event Cleared(address indexed account, uint64 validUntil);
    event Revoked(address indexed account);

    error NotAttestor();
    error BadSignature();
    error Expired();

    constructor(address owner_, address attestor_, bool enforced_)
        SpareAuth(owner_)
        EIP712("SPARE ScreeningGate", "1")
    {
        attestor = attestor_;
        enforced = enforced_;
    }

    function setAttestor(address attestor_) external onlyOwner {
        attestor = attestor_;
        emit AttestorSet(attestor_);
    }

    function setEnforced(bool enforced_) external onlyOwner {
        enforced = enforced_;
        emit EnforcedSet(enforced_);
    }

    /// @notice Attestor clears an account directly.
    function clear(address account, uint64 validUntil) external {
        if (msg.sender != attestor) revert NotAttestor();
        clearedUntil[account] = validUntil;
        emit Cleared(account, validUntil);
    }

    /// @notice Account submits an attestor-signed clearance itself (gasless for
    ///         the attestor).
    function submitClearance(uint64 validUntil, bytes calldata signature) external {
        if (validUntil < block.timestamp) revert Expired();
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(CLEARANCE_TYPEHASH, msg.sender, validUntil, nonces[msg.sender]))
        );
        if (ECDSA.recover(digest, signature) != attestor) revert BadSignature();
        unchecked {
            nonces[msg.sender]++;
        }
        clearedUntil[msg.sender] = validUntil;
        emit Cleared(msg.sender, validUntil);
    }

    /// @notice Attestor or owner can withdraw a clearance at any time.
    function revoke(address account) external {
        if (msg.sender != attestor && msg.sender != owner()) revert NotAttestor();
        clearedUntil[account] = 0;
        // Kill any signed clearance still in the account's hands.
        unchecked {
            nonces[account]++;
        }
        emit Revoked(account);
    }

    function isEligible(address account) external view returns (bool) {
        if (!enforced) return true;
        return clearedUntil[account] >= block.timestamp;
    }
}
