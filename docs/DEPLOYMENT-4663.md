# SPARE on Robinhood Chain mainnet (4663)

Build: the deployed bytecode was built from a pre-release commit that is not in the public history; the source here reproduces it byte for byte (see Verification)

| | |
|---|---|
| Network | Robinhood Chain mainnet, chain id 4663 (Arbitrum Nitro, ETH gas) |
| Explorer | <https://robinhoodchain.blockscout.com> |
| Deployed | blocks 76221503–76221683, 2026-09-30 04:14 UTC, by `script/Deploy.s.sol` from a pre-release source commit |
| Deployer | `0x56B67D71039365083727b661Dbe9Bdb7f7D15189` (still the owner, see below) |
| Compiler | solc `0.8.26+commit.8a97fa7a`, via-IR, optimizer 200 runs, EVM `cancun`, `bytecode_hash = "none"`, no linked libraries |
| Address book | [`contracts/addresses/4663.json`](../contracts/addresses/4663.json) |
| Creation record | [`contracts/deployments/4663-contracts.json`](../contracts/deployments/4663-contracts.json) (tx, block, constructor args; `contracts/broadcast/` is not committed) |
| Config | [`contracts/config/4663.json`](../contracts/config/4663.json): 36 assets registered, 26 active, 10 on standby (INTC benched and MU re-pinned to its hooked pool on 2026-10-02), default mix SPY 60 / NVDA 40 |

## Contracts

| Contract | Address | Creation tx | Block | Admin | Constructor args |
|---|---|---|---|---|---|
| AssetRegistry | [`0x6dA6e49E2c59b622697a208a83bF266D5268c937`](https://robinhoodchain.blockscout.com/address/0x6dA6e49E2c59b622697a208a83bF266D5268c937) | [`0x99fe2068…3b93e961`](https://robinhoodchain.blockscout.com/tx/0x99fe20683951863be2cf28cd61e6d0fe679c56afb67207db4adc21913b93e961) | 76221503 | Ownable2Step | owner, USDG |
| RuleRegistry | [`0x477504Fdd8929fC75Ac6836C2aa131D765e85f78`](https://robinhoodchain.blockscout.com/address/0x477504Fdd8929fC75Ac6836C2aa131D765e85f78) | [`0x4a9ae5f0…b2335bc`](https://robinhoodchain.blockscout.com/tx/0x4a9ae5f010b9450bfa7339b43711a32163c2935319b533d293c5e019db2335bc) | 76221523 | none | — |
| ElectionRegistry | [`0x05fB5B11B676BC0Fbf893480b4101fB7C8Db0543`](https://robinhoodchain.blockscout.com/address/0x05fB5B11B676BC0Fbf893480b4101fB7C8Db0543) | [`0x7184ee48…4be1da`](https://robinhoodchain.blockscout.com/tx/0x7184ee48f6ba3050161229a49a09a9dc1e5e756dab3193f4fbd527e51b4be1da) | 76221543 | Ownable2Step | owner, AssetRegistry |
| ScreeningGate | [`0xC3289C38c53055d58009B2fa9499c753b3dBCED3`](https://robinhoodchain.blockscout.com/address/0xC3289C38c53055d58009B2fa9499c753b3dBCED3) | [`0xcbaec7e7…6a674c`](https://robinhoodchain.blockscout.com/tx/0xcbaec7e74090e90cd0e51f71cd8086029b71c6cd62afde5c66bc8a30ae6a674c) | 76221563 | Ownable2Step | owner, attestor (= owner), enforced `false` |
| StockRouter | [`0x1Fec3654Fea787a63104a6634C9781B837B5e17E`](https://robinhoodchain.blockscout.com/address/0x1Fec3654Fea787a63104a6634C9781B837B5e17E) | [`0x8991b957…270517dd`](https://robinhoodchain.blockscout.com/tx/0x8991b957ae84ad60a3142cc136dfad1cb8a152f1fe86e6acc054f352270517dd) | 76221583 | Ownable2Step | owner, v4 PoolManager, AssetRegistry |
| CashPark | [`0x947538724Ed80BA609B4A1B4bBCb62d7f3Cd6Abb`](https://robinhoodchain.blockscout.com/address/0x947538724Ed80BA609B4A1B4bBCb62d7f3Cd6Abb) | [`0x2b2c51eb…4cdc113`](https://robinhoodchain.blockscout.com/tx/0x2b2c51eb1aed8d453e6446d48d1b0bec034a88a0c576d36faa02b5bf31cdc113) | 76221603 | Ownable2Step | owner, USDG |
| FeeVault | [`0xF5B9C500998D122fbBB606f23DBEe91Aa5549add`](https://robinhoodchain.blockscout.com/address/0xF5B9C500998D122fbBB606f23DBEe91Aa5549add) | [`0x4a66ab53…93d2c71`](https://robinhoodchain.blockscout.com/tx/0x4a66ab530c60a047dbb7c665c5626b71e2e40ba0ccd6f13fc1d3d87bf93d2c71) | 76221623 | Ownable2Step | owner |
| SweepExecutor | [`0x908F545d0FB87fAC3b225cbd12E899BCE77147Ab`](https://robinhoodchain.blockscout.com/address/0x908F545d0FB87fAC3b225cbd12E899BCE77147Ab) | [`0x9071cdbf…68fe0a6e3`](https://robinhoodchain.blockscout.com/tx/0x9071cdbf0ca40ca029b79e3ad4611935d741c96cb50f07a64e8906768fe0a6e3) | 76221643 | Ownable2Step | owner, Permit2, RuleRegistry, ElectionRegistry, ScreeningGate, StockRouter, CashPark, FeeVault |
| UsdgParkAdapter | [`0x1E29fD4F78cDfabdE3Df605e66aE3d78a8980DD8`](https://robinhoodchain.blockscout.com/address/0x1E29fD4F78cDfabdE3Df605e66aE3d78a8980DD8) | [`0x342d5139…5d14a9`](https://robinhoodchain.blockscout.com/tx/0x342d513934f999e567af4dff2f7867d6f905b56184572b0b0401907449fc64a9) | 76221663 | none (CashPark only) | USDG, CashPark |
| SgovParkAdapter | [`0x4197a7Eb8e08a35fd55273afA3D0f8Cb3bd98525`](https://robinhoodchain.blockscout.com/address/0x4197a7Eb8e08a35fd55273afA3D0f8Cb3bd98525) | [`0xafc2a1c3…5e96a3a`](https://robinhoodchain.blockscout.com/tx/0xafc2a1c332df90578679a3283ecf3bde26b9924f438c7e20d499b58115e96a3a) | 76221683 | none (CashPark only) | USDG, SGOV, CashPark, StockRouter, slippage 100 bps |

The live park adapter is `UsdgParkAdapter`; `SgovParkAdapter` is deployed and
pre-authorised on `StockRouter` but on standby (not `CashPark.adapter`).

External contracts SPARE depends on: USDG
[`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`](https://robinhoodchain.blockscout.com/address/0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168)
(Paxos, 6 dp), Permit2
[`0x000000000022D473030F116dDEE9F6B43aC78BA3`](https://robinhoodchain.blockscout.com/address/0x000000000022D473030F116dDEE9F6B43aC78BA3),
Uniswap v4 PoolManager
[`0x8366a39CC670B4001A1121B8F6A443A643e40951`](https://robinhoodchain.blockscout.com/address/0x8366a39CC670B4001A1121B8F6A443A643e40951),
one Chainlink feed per asset (in the config), and for MU and GME the third-party fee
hooks of their pinned pools, whose operator sets those pools' fees
([`ROLES.md`](ROLES.md), accepted risk A-L3 in [`SECURITY.md`](../SECURITY.md)).

## Roles and current holders

Read live on 2026-10-03 at 00:39 UTC, block 78666930, with `contracts/scripts/roles.sh`
(output: [`contracts/deployments/4663-roles-2026-10-03.txt`](../contracts/deployments/4663-roles-2026-10-03.txt)).
Full table of every privileged function: [`ROLES.md`](ROLES.md). Times here are UTC.

| Role | Holder | On |
|---|---|---|
| owner | `0x56B67D71039365083727b661Dbe9Bdb7f7D15189` (EOA), no pending owner | all 7 Ownable2Step contracts |
| pauser | `0x56B67D71039365083727b661Dbe9Bdb7f7D15189`; nothing is paused | all 7 |
| attestor | `0x56B67D71039365083727b661Dbe9Bdb7f7D15189`; screening not enforced | ScreeningGate |
| keeper | `0x61B47c967dCC2B1A253644cD2ddCeff8d99D6d03`, granted 2026-10-02 23:31 UTC (blocks 78626507, 78626535), a fresh key before the public release; the original keeper `0xB7FE91DF829FD2F616c111EDFb9f7B5703FE84fD`, granted at deploy (blocks 76222004 on CashPark, 76222024 on SweepExecutor), was revoked at 23:35 UTC (blocks 78628466, 78628492). These six are all the `KeeperSet` events | CashPark, SweepExecutor |
| executor | SweepExecutor | CashPark |
| router callers | SweepExecutor, SgovParkAdapter (the only `CallerSet` grants ever) | StockRouter |
| sequencer feed | none (`0x0`; RHC publishes no sequencer-uptime feed) | StockRouter |

Parameters: threshold 5 USDG, fee 25 bps, executor slippage 150 bps, epoch 86400 s,
finality buffer 3000 L2 blocks. Value held at block 78666930: CashPark 0 USDG, FeeVault 0
USDG. Use so far, from the contracts' events up to that block: one `Linked` and one
`RuleSet` (one account), four `Accrued` of 0 USDG, no `Credited`, `AccountSwept`,
`Bought` or `Exited`.

The owner → 2-of-3 Safe + 48 h timelock hand-over is prepared and rehearsed, not
executed: [`GOVERNANCE.md`](GOVERNANCE.md),
[`contracts/deployments/governance-rehearsal-2026-10-02.txt`](../contracts/deployments/governance-rehearsal-2026-10-02.txt).

## Verification

### Wiring: `VerifyDeployment` against mainnet

Read-only (`forge script` without `--broadcast`; the script opens no broadcast
bracket), on 2026-10-03 00:53–00:55 UTC, blocks 78674838–78676091 (the latest block
at start and at the end), against the `config/4663.json` and `addresses/4663.json` of
this release, so after the keeper rotation (2026-10-02 23:31 UTC) and the registry
change of 2026-10-02 (MU re-pinned, INTC benched). Result: **334 passed, 0 failed, 1
warning** (governance), recorded in
[`contracts/deployments/4663-verify-2026-10-03.txt`](../contracts/deployments/4663-verify-2026-10-03.txt):

```
SUMMARY: 334 passed, 0 failed, 1 warnings; ownership pending acceptance on 0/7 contracts
  [warn] config hash differs from the one recorded at deploy (0x5a9ab6c4…1620a0); the checks above ran against the CURRENT config
VerifyDeployment: PASS
```

Every check passed: code at all 10 addresses; every immutable and cross-link; both
USDG allowances; router callers (and the non-callers: UsdgParkAdapter, deployer,
keeper); executor, keeper, pauser and attestor; nothing paused; ownership accepted on
7/7; the five SweepExecutor parameters; all 36 registry entries, 26 active and 10 on
standby (feed, decimals, heartbeat, band, active flag, exact PoolKey, pool initialised,
in-range liquidity for every active asset, oracle status, an 18-decimal token, a
heartbeat of at most 26 h); for the hooked MU and GME pools, hook flags with no
`*_RETURNS_DELTA` permission, the pinned code hash and authority, and the keeper's fee
ceiling inside the band; the default mix; both adapters. Full output:
[`contracts/deployments/4663-verify-2026-10-03.txt`](../contracts/deployments/4663-verify-2026-10-03.txt).
Earlier runs, each against the config of its time:
[`4663-verify-2026-10-02-2045Z.txt`](../contracts/deployments/4663-verify-2026-10-02-2045Z.txt)
(2026-10-02 20:45 UTC, after the registry change but before the keeper rotation, so with
the original keeper) and
[`4663-verify-2026-10-02.txt`](../contracts/deployments/4663-verify-2026-10-02.txt)
(05:31 UTC, before the registry change).

Both `[warn]` lines are expected. The one warning the summary counts is the
governance-policy section's: the owner of all 7 contracts is still an EOA, so its calls
take effect at once (the hand-over is [`GOVERNANCE.md`](GOVERNANCE.md)). The line under
the summary is a note, not a counted warning: the config hash recorded at deploy differs
from the current `config/4663.json`, because the asset universe was extended afterwards
with `AddAssets.s.sol`, and the checks ran against the current config.

The two SweepExecutor USDG allowances (to StockRouter and to CashPark) must be at least
`type(uint256).max / 2`, not exactly max: USDG decrements even an unlimited allowance on
every `transferFrom`, so an exact-max check would fail after the first accrual or sweep
although nothing is wrong (shown on a fork in the governance rehearsal, step 12). Half of
max is still unlimited for any real volume.

Re-run:

```bash
cd contracts && set -a && . ./.env && set +a      # never echo the values
../scripts/spare-forge.sh VerifyDeployment --rpc-url "$RHC_RPC_URL"
```

### Bytecode: the source here reproduces every contract

`contracts/scripts/verify-blockscout.sh check` (read-only) rebuilt all 10 contracts with
the settings above and, for each, compared the build's creation bytecode plus the
re-encoded constructor arguments with the creation transaction's input read from the
chain, then did the same with the exact standard-JSON input an explorer would compile:
**all 10 match byte for byte**, and every receipt's contract address and block match
the record. The source in this repository differs from the deployed build's source only in
comments (`StockRouter.sol`, `libraries/OracleGuard.sol`), which `bytecode_hash = "none"`
keeps out of the bytecode.

### Explorer source verification

| | Status on 2026-10-02 |
|---|---|
| Sourcify (which Blockscout displays) | **verified, all 10** (`match`; `bytecode_hash = "none"` leaves no metadata hash, so `exact_match` is not possible). Submitted 2026-10-02 with `VERIFIER=sourcify ... submit`. Check any of them at `https://sourcify.dev/server/v2/contract/4663/<address>`. |
| Blockscout direct | the explorer API puts scripted requests behind a bot check (HTTP 403), so no direct Blockscout submission was made; Blockscout shows the Sourcify match. Open any address link above, tab "Contract". |

To re-run (`submit` publishes the source, so it needs `SPARE_VERIFY_ACK=publish-source`):

```bash
contracts/scripts/verify-blockscout.sh commands          # the exact forge verify-contract calls
SPARE_VERIFY_ACK=publish-source contracts/scripts/verify-blockscout.sh submit
contracts/scripts/verify-blockscout.sh status
```

`submit` runs `check` first and stops on any mismatch. If the explorer's bot check
refuses the CLI, `verify-blockscout.sh json` writes each standard-JSON input for the
explorer's "Verify & Publish → Solidity (Standard JSON input)" form, with the compiler
version and constructor arguments.
