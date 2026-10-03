// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Audit probe: measure what the real Nitro ArbSys precompile costs under
///         L2Clock's 10k gas cap. Used via eth_call with a code override only.
contract ArbSysProbe {
    function probe(uint256 cap)
        external
        view
        returns (bool ok, uint256 used, uint256 l2, uint256 l1, uint256 retLen)
    {
        uint256 g = gasleft();
        (bool s, bytes memory r) = address(0x64).staticcall{gas: cap}(abi.encodeWithSignature("arbBlockNumber()"));
        used = g - gasleft();
        ok = s;
        retLen = r.length;
        if (s && r.length == 32) l2 = abi.decode(r, (uint256));
        l1 = block.number;
    }
}
