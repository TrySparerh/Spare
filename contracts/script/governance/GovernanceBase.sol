// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {SpareBase} from "../lib/SpareBase.sol";

/// @notice The slice of the Safe v1.4.1 ABI the governance scripts read.
interface ISafe {
    function VERSION() external view returns (string memory);
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
    function getModulesPaginated(address start, uint256 pageSize)
        external
        view
        returns (address[] memory array, address next);
    function nonce() external view returns (uint256);
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce_
    ) external view returns (bytes32);
}

/// @title GovernanceBase
/// @notice Shared by the owner -> Safe + timelock hand-over scripts (DeployTimelock,
///         HandOver, TimelockBatch): the canonical Safe v1.4.1 deployment on RHC, the
///         checks a Safe and the timelock must pass before any power moves to them,
///         and the Safe Transaction Builder JSON the owner Safe imports.
/// @dev Target layout (docs/GOVERNANCE.md):
///        owner of the 7 Ownable2Step contracts  = TimelockController, minDelay >= 48h
///        timelock proposer + canceller + executor = the owner Safe (2-of-3, hardware)
///        timelock admin                          = the timelock itself, nobody else
///        pauser of the 7                         = a SEPARATE pauser Safe (no delay)
///        ScreeningGate attestor                  = SPARE_ATTESTOR (default pauser Safe)
///        keeper                                  = unchanged (the bounded hot key)
abstract contract GovernanceBase is SpareBase {
    // Safe v1.4.1 canonical deployments (safe-global/safe-deployments lists 4663 as
    // "canonical"). Addresses and runtime code hashes read on 4663 on 2026-10-02 and
    // equal to the canonical codeHash values published there.
    address internal constant SAFE_L2_SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address internal constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
    bytes32 internal constant SAFE_L2_SINGLETON_CODEHASH =
        0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff;
    bytes32 internal constant SAFE_SINGLETON_CODEHASH =
        0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4;
    /// @dev keccak256("guard_manager.guard.address"), Safe v1.4.1 GuardManager.
    bytes32 internal constant SAFE_GUARD_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
    address internal constant SAFE_SENTINEL = address(0x1);

    /// @notice Project policy for fund-holding contracts: at least 48 h between an
    ///         owner action being announced on-chain and it taking effect.
    uint256 internal constant MIN_DELAY = 48 hours;
    string internal constant MAINNET_ACK = "owner-approved";

    bytes32 internal constant ROLE_GRANTED = keccak256("RoleGranted(bytes32,address,address)");
    /// @dev ~5.8 days of RHC blocks (~10 per second) per eth_getLogs call.
    uint256 internal constant LOG_CHUNK = 5_000_000;
    /// @dev A healthy timelock has 4 grants; anything near this is refused anyway.
    uint256 internal constant MAX_GRANTS = 32;

    error Refused(string why);

    // ── context ────────────────────────────────────────────────────────────

    function _broadcasting() internal view returns (bool) {
        return vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
    }

    /// @dev The broadcaster (`--sender`, `--private-key`, `--ledger`, ...). Nothing is
    ///      sent in this bracket.
    function _sender() internal returns (address sender) {
        vm.startBroadcast();
        (, sender,) = vm.readCallers();
        vm.stopBroadcast();
    }

    function _requireMainnetAck() internal view {
        if (block.chainid != MAINNET || !_broadcasting()) return;
        string memory ack = vm.envOr("SPARE_MAINNET_ACK", string(""));
        if (keccak256(bytes(ack)) != keccak256(bytes(MAINNET_ACK))) {
            revert Refused("chain 4663 BROADCAST needs SPARE_MAINNET_ACK=owner-approved");
        }
    }

    function _resetCounts() internal {
        _passed = 0;
        _failed = 0;
        _warned = 0;
    }

    /// @dev Addresses that must never sign for, or be handed, a governance role: the
    ///      outgoing owner key, the deployer and the keeper hot key.
    function _hotKeys(Deployment memory d, string memory addressesJson, address sender)
        internal
        pure
        returns (address[] memory k)
    {
        k = new address[](3);
        k[0] = sender;
        k[1] = d.deployer;
        k[2] = vm.parseJsonAddress(addressesJson, ".roles.keeper");
    }

    // ── checks ─────────────────────────────────────────────────────────────

    /// @notice A Safe v1.4.1 proxy on a canonical singleton with no module and no guard
    ///         (either lets something other than the signers act), a threshold of at
    ///         least `minThreshold` over at least `minOwners` signers, none of them in
    ///         `forbidden`.
    function _checkSafe(
        string memory label,
        address safe,
        uint256 minThreshold,
        uint256 minOwners,
        address[] memory forbidden
    ) internal {
        _section(string.concat(label, " ", vm.toString(safe)));
        if (safe.code.length == 0) {
            _check(false, string.concat(label, " has code"));
            return;
        }
        address singleton = address(uint160(uint256(vm.load(safe, 0))));
        bool canonical = (singleton == SAFE_L2_SINGLETON && singleton.codehash == SAFE_L2_SINGLETON_CODEHASH)
            || (singleton == SAFE_SINGLETON && singleton.codehash == SAFE_SINGLETON_CODEHASH);
        _check(canonical, string.concat("proxy of a canonical Safe v1.4.1 singleton (", vm.toString(singleton), ")"));
        if (!canonical) return; // nothing below means anything on unknown code

        ISafe s = ISafe(safe);
        _check(keccak256(bytes(s.VERSION())) == keccak256("1.4.1"), "VERSION() = 1.4.1");
        uint256 t = s.getThreshold();
        address[] memory owners = s.getOwners();
        _check(
            t >= minThreshold && owners.length >= minOwners,
            string.concat(
                "threshold ", vm.toString(t), " of ", vm.toString(owners.length), " signers (policy: at least ",
                vm.toString(minThreshold), " of ", vm.toString(minOwners), ")"
            )
        );
        for (uint256 i; i < owners.length; ++i) {
            bool bad;
            for (uint256 j; j < forbidden.length; ++j) {
                if (owners[i] == forbidden[j]) bad = true;
            }
            _check(!bad, string.concat("signer ", vm.toString(owners[i]), " is not a hot key / the outgoing owner"));
            if (owners[i].code.length != 0) _warn(string.concat("signer ", vm.toString(owners[i]), " is a contract, not a hardware EOA"));
        }
        (address[] memory mods,) = s.getModulesPaginated(SAFE_SENTINEL, 10);
        _check(mods.length == 0, "no modules enabled (a module acts without the signers)");
        _check(vm.load(safe, SAFE_GUARD_SLOT) == bytes32(0), "no transaction guard set");
    }

    /// @notice The timelock is the OpenZeppelin TimelockController this repo builds,
    ///         with minDelay >= 48h, the owner Safe as proposer, canceller and executor,
    ///         and only itself as admin.
    /// @param scanFrom first block of a RoleGranted log scan that re-reads every role
    ///        ever granted, so no extra holder can hide; 0 skips the scan (a timelock
    ///        deployed in this same simulation has no logs on the RPC yet).
    function _checkTimelock(TimelockController tl, address ownerSafe, uint256 scanFrom) internal {
        _section(string.concat("TimelockController ", vm.toString(address(tl))));
        if (address(tl).code.length == 0) {
            _check(false, "timelock has code");
            return;
        }
        _check(
            address(tl).codehash == keccak256(type(TimelockController).runtimeCode),
            "runtime code = OpenZeppelin TimelockController (v5.0.2, this repo's compiler settings)"
        );
        uint256 delay = tl.getMinDelay();
        _check(delay >= MIN_DELAY, string.concat("minDelay ", vm.toString(delay), " s >= 172800 s (48 h)"));
        _check(tl.hasRole(tl.PROPOSER_ROLE(), ownerSafe), "owner Safe holds PROPOSER_ROLE");
        _check(tl.hasRole(tl.CANCELLER_ROLE(), ownerSafe), "owner Safe holds CANCELLER_ROLE");
        _check(tl.hasRole(tl.EXECUTOR_ROLE(), ownerSafe), "owner Safe holds EXECUTOR_ROLE");
        _check(!tl.hasRole(tl.EXECUTOR_ROLE(), address(0)), "execution is not open to everyone (no EXECUTOR_ROLE on 0x0)");
        _check(tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), address(tl)), "the timelock administers itself");
        if (scanFrom == 0) return;

        bytes32[] memory topics = new bytes32[](1);
        topics[0] = ROLE_GRANTED;
        bytes32[MAX_GRANTS] memory seenRole;
        address[MAX_GRANTS] memory seenAccount;
        uint256 seen;
        uint256 held;
        uint256 head = vm.getBlockNumber();
        // Chunked so the scan stays inside RPC log-range limits however old the timelock is.
        for (uint256 from = scanFrom; from <= head; from += LOG_CHUNK) {
            uint256 to = from + LOG_CHUNK - 1 < head ? from + LOG_CHUNK - 1 : head;
            VmSafe.EthGetLogs[] memory logs = vm.eth_getLogs(from, to, address(tl), topics);
            for (uint256 i; i < logs.length; ++i) {
                bytes32 role = logs[i].topics[1];
                address account = address(uint160(uint256(logs[i].topics[2])));
                bool dup;
                for (uint256 j; j < seen; ++j) {
                    if (seenRole[j] == role && seenAccount[j] == account) dup = true;
                }
                if (dup) continue;
                if (seen == MAX_GRANTS) {
                    _check(false, string.concat("more than ", vm.toString(MAX_GRANTS), " distinct role grants"));
                    return;
                }
                seenRole[seen] = role;
                seenAccount[seen] = account;
                ++seen;
                if (!tl.hasRole(role, account)) continue; // revoked since
                ++held;
                bool expected = (role == tl.DEFAULT_ADMIN_ROLE() && account == address(tl))
                    || (account == ownerSafe
                        && (role == tl.PROPOSER_ROLE() || role == tl.CANCELLER_ROLE() || role == tl.EXECUTOR_ROLE()));
                _check(expected, string.concat("live role holder: ", _roleName(tl, role), " ", vm.toString(account)));
            }
        }
        _check(
            held >= 4,
            string.concat(
                "RoleGranted scan from block ", vm.toString(scanFrom), " covers the deployment (", vm.toString(held),
                " live grants)"
            )
        );
    }

    function _roleName(TimelockController tl, bytes32 role) internal view returns (string memory) {
        if (role == tl.DEFAULT_ADMIN_ROLE()) return "DEFAULT_ADMIN_ROLE";
        if (role == tl.PROPOSER_ROLE()) return "PROPOSER_ROLE";
        if (role == tl.CANCELLER_ROLE()) return "CANCELLER_ROLE";
        if (role == tl.EXECUTOR_ROLE()) return "EXECUTOR_ROLE";
        return vm.toString(role);
    }

    // ── output ─────────────────────────────────────────────────────────────

    /// @notice One-transaction Safe Transaction Builder batch (value 0, CALL), in the
    ///         same shape AcceptOwnership.s.sol prints.
    function _txBuilderJson(
        string memory name,
        string memory description,
        address safe,
        address to,
        bytes memory data
    ) internal view returns (string memory) {
        return string.concat(
            "{\"version\":\"1.0\",\"chainId\":\"", vm.toString(block.chainid), "\",\"meta\":{\"name\":\"", name,
            "\",\"description\":\"", description, "\",\"createdFromSafeAddress\":\"", vm.toString(safe),
            "\"},\"transactions\":[{\"to\":\"", vm.toString(to), "\",\"value\":\"0\",\"data\":\"", vm.toString(data),
            "\",\"contractMethod\":null,\"contractInputsValues\":null}]}"
        );
    }

    /// @notice The hash the Safe's signers approve for {to, 0, data, CALL} at `nonce_`.
    ///         Safe{Wallet} and hardware wallets display it; signers compare it to this.
    function _safeTxHash(address safe, address to, bytes memory data, uint256 nonce_) internal view returns (bytes32) {
        return ISafe(safe).getTransactionHash(to, 0, data, 0, 0, 0, 0, address(0), address(0), nonce_);
    }
}
