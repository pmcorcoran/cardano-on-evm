# Build and deployment

The initial `0.1.0` release uses portable derivation for all profiles. Every
operator supplies current infrastructure and profile manifests. Core installation
does not install Alto. Public-network deployment is a separately authorized
operator action; the local acceptance harness uses generated keys and fresh Anvil.

## Prerequisites and clean reproduction

Use the pinned Node 26.8.1/npm 11.19.0, Python 3.13, Playwright 1.62.0 and
Foundry/Anvil 1.8.1 for the full local lanes. Package consumers support Node
>=22.18.0. Compiler settings remain Solidity 0.8.30, Cancun, optimizer 200,
Kernel via IR and cryptography without IR. See [versions](../versions.json).

```sh
npm ci --ignore-scripts
node scripts/install-foundry.mjs
python3 -m venv .local/browser-venv
.local/browser-venv/bin/python -m pip install --require-hashes -r tests/browser/requirements.txt
.local/browser-venv/bin/python -m playwright install chromium
python3 scripts/check-clean-source.py --out .local/core-check --python=.local/browser-venv/bin/python
```

Install Chromium's OS dependencies when required by the host. The clean harness
uses Git's actual ignore rules in a disposable repository and exports its index;
it never changes the real index or force-adds missing inputs. It verifies source
hashes and executable bits, builds contracts/packages, executes local account,
replay, policy and browser checks, and stops its services. Fresh output paths
and free ports are required. See the complete [acceptance gates](acceptance.md).

For individual local examples:

```sh
npm run build:contracts
node scripts/build-entrypoint-reference.mjs
npm run build
.local/tools/foundry/anvil --host 127.0.0.1 --port 8545 --chain-id 31337 --hardfork cancun
```

With Anvil running, use another terminal:

```sh
node node_modules/tsx/dist/cli.mjs examples/deploy-infrastructure.ts --network=local --entrypoint-artifact=artifacts/entrypoint-reference.json --out=.local/example-infrastructure.json
npm run experiment:sdk
npm run experiment:policies
node node_modules/tsx/dist/cli.mjs scripts/experiments/crypto-corpus.ts
```

The reference EntryPoint build is an explicit local compiler target; the pinned
upstream EntryPoint artifact remains a separate source input. Generated fixture
results carry no real-wallet or public-chain acceptance claim.

## Base Sepolia infrastructure

`versions.json` retains configured upstream addresses and runtime hashes.
`npm run check:network -- --network=base-sepolia --out=.local/network-check.json`

Read-only submitter checks use `scripts/check-submitter.ts --key-file=PATH
--out=PATH.json`. The testnet self-deposit helper `scripts/fund-base-sepolia.ts`
requires `--key-file=PATH --journal=PATH.json`; reuse that same explicit journal
to inspect a pending deposit with `--status`. It previews by default and sends
only with `--send`. The read-only upstream comparison
`scripts/experiments/verify-mainnet-context.ts` requires `--out=PATH.json`.
performs a fresh read-only check; no stored verification flag substitutes for
that observation. Use a dedicated test deployer and an operator-owned protected
key file. Begin with an unsigned plan:

```sh
node node_modules/tsx/dist/cli.mjs examples/deploy-infrastructure.ts --network=base-sepolia --deployer=0xYOUR_DEPLOYER --out=.local/my-infrastructure.json
```

The plan deploys PreparedTableFactory, ProfilePreparationFactory, target and
selector policies, and a counter. Review creation data, nonce order, predicted
addresses and `.profiles.json`. `--recipient=0xADDRESS` selects the allowed
transfer recipient. With separate authorization, the same command using
`--key-file=/absolute/path/submitter.env --send` deploys and checks canonical
receipts, runtime bytes and immutable bindings. The reference app refuses an
infrastructure plan marked unverified.

Use one journal and a serialized nonce lock per network/submitter. Never send
uncoordinated transactions from the same EOA. The helper records the transaction
hash before broadcast and resolves it after a timeout. Creation is capped at
16 million gas and 0.0015 ETH maximum execution fee on the test network; Base L1
charges remain separate. Review total funding before any send.

## Prepare and fund a newly enrolled Cardano key

Start the reference app with the supplied verified profile manifest. It saves
new enrollment records under `.local/reference-evidence` by default. Preview
preparation and funding using the exact current enrollment and manifest:

```sh
node node_modules/tsx/dist/cli.mjs examples/prepare-enrolled-account.ts --enrollment=.local/reference-evidence/enrollment-CHALLENGE_ID.json --manifest=.local/my-infrastructure.json.profiles.json --profile=general --deposit=0.0001 --balance=0.000001
```

The helper checks signature/configuration, independent identity and artifact
bindings. A separately authorized send also requires `--infrastructure`,
`--journal`, `--key-file` and `--send`; use the explicit input names shown by the
example. Preparation generates and checks the curve table and immutable profile
onchain. Payers gain no account authority. A deposit funds EntryPoint gas; native
balance funds the actual transfer. Neither replaces a Cardano operation signature.

Keep the transaction journal across restarts. Reusing a funding ID with different
amounts is rejected; a later reviewed replenishment uses a new `--funding-id`.
The reference server provides no automatic faucet or per-visitor preparation.

The reusable scripts in `scripts/experiments/` also expose explicit paths:
`prepare-live-profiles` takes manifest/capture/infrastructure/journal/output;
`prepare-profile-operation` takes manifest/output plus profile/route/action;
`prepare-live-operation` takes stake/infrastructure/journal/namespace/output;
`prepare-stake` takes capture/differential/infrastructure/journal/output.
Submission takes request/signature/infrastructure/journal/output, and verification
or gas measurement takes the corresponding records and an output path. None is
part of a public send during local validation.

## Base mainnet procedure

The network planner supports a read-only Base mainnet preflight and unsigned
infrastructure output. It rejects mainnet `--send`. Separately authorized
operators must verify chain-specific runtime hashes and every immutable,
configure providers/fees/funding/credential scope, and run full acceptance on
that exact configuration. The loopback reference app targets Base Sepolia and
requires explicit adaptation for another network.

Chain ID leaves account salts unchanged but binds enrollment and operation
authorization. Matching addresses across networks requires identical relevant
infrastructure addresses and bytes. Kernel embeds its constructor chain context
in runtime; the controlled context in the two-chain local test is a prerequisite,
not a claim that arbitrary public deployments have identical bytes.

Review [security](security.md), [authority](policies.md) and [operations](operations.md).

## Eternl acceptance setup

The browser apps accept explicit Lace/Eternl selection. Use a desktop software
wallet, record its actual extension release and browser version, and start with
the [wallet format checkpoint](reference-app.md#wallet-changes). CIP-30 API
versions are recorded separately from extension releases. Enrollment and the
32-byte format probe must preserve exactly the same signing key/header bytes.

Use fresh Eternl stake enrollment for general, target and selector profiles.
The required Base Sepolia routes, funding prerequisites and outstanding operator
dependency are tracked in [Eternl acceptance](eternl-acceptance.md). Keep the
existing submitter journal and nonce lock, current manifests and fee caps; no
mainnet transaction or publication is part of that work. Changing the wallet
does not transfer balances between the resulting Base accounts.
