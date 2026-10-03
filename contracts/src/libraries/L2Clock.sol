// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title L2Clock
/// @notice The Robinhood Chain (L2) block number.
/// @dev RHC is Arbitrum Nitro. On Nitro, Solidity's `block.number` returns an
///      ESTIMATE OF THE L1 BLOCK and updates only periodically (see the RHC docs,
///      "Differences from Ethereum"). The engine's observer indexes by L2 block, so
///      comparing its numbers against `block.number` would compare two different
///      clocks — a finality check built that way is silently wrong on every call.
///
///      The real L2 number comes from the ArbSys precompile at 0x64. Nitro nodes
///      report the code at 0x64 as `0xfe` — the INVALID opcode, a placeholder for
///      the native precompile. Anywhere the precompile is not native (an anvil
///      fork, a non-Nitro chain), a call there executes INVALID and burns ALL the
///      gas it was forwarded; uncapped, that was ~63/64 of the transaction's gas
///      and starved every call after it. So the call is capped: the real
///      precompile costs a few hundred gas, and a failed call falls back to
///      `block.number` (which, on an anvil fork, is the forked L2 number).
library L2Clock {
    address internal constant ARBSYS = address(0x64);
    uint256 internal constant ARBSYS_GAS = 10_000;

    function blockNumber() internal view returns (uint256) {
        (bool ok, bytes memory ret) =
            ARBSYS.staticcall{gas: ARBSYS_GAS}(abi.encodeWithSignature("arbBlockNumber()"));
        if (ok && ret.length == 32) return abi.decode(ret, (uint256));
        return block.number;
    }
}
