// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Minimal ERC-1271 smart wallet: a signature is valid when it recovers to
///         the wallet's EOA signer.
contract Mock1271Wallet {
    address public immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        (address rec, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, sig);
        return (err == ECDSA.RecoverError.NoError && rec == signer) ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
