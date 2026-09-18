# Portable account addresses, version 0.1.0

General, restricted and experimental-general accounts use portable derivation.
For otherwise identical configurations, changing only chain ID preserves the
account salt, address, initialization and factory calldata. Enrollment hashes
and operation authorization remain bound to the destination chain.

`TableIdentityConfig` and `ProfileIdentityConfig` contain the address inputs and
required chain ID. `CardanoAccount.config` is a frozen, read-only
`ResolvedAccountConfig`. Derivation is unconditional. Runtime configuration
validation rejects the unsupported `addressDerivationMode` field, including
before enrollment or operation signing reaches a wallet.

## Address and authorization domains

The general/restricted factory uses exactly
`keccak256(abi.encode(ACCOUNT_DOMAIN, namespace, index))`, where
`ACCOUNT_DOMAIN = keccak256("cardano-kernel:profile-account:v1")` and the ABI types
are `(bytes32,bytes32,uint256)`. Its `accountSalt(bytes32,uint256)` function is pure.

Experimental-general uses the salt domain
`cardano-kernel:identity:v1:experimental-general`. Its ABI encoding excludes
chain ID and includes the infrastructure addresses, validator creation-code hash,
namespace and index. This salt domain has no suffix.

Enrollment configuration hashes use separate domains:

- General/restricted: `cardano-kernel:identity:v1:profile:portable`.
- Experimental-general: `cardano-kernel:identity:v1:experimental-general:portable`.

Both enrollment hashes include chain ID and the complete ordered configuration.
The `:portable` suffix is part of the protocol. Full encodings appear in
[experimental identity](identity.md) and [profile identity](policies.md#deterministic-profile-identity).
An enrollment hash is not an address salt. Chain ID must be a positive safe
integer, and challenge scope is checked before `wallet.signData`. Operation
payloads bind the EntryPoint v0.7 digest to the chain and Cardano operation domain.

## Matching infrastructure and verified manifests

Portability requires matching keys, exact protected headers, namespace, index,
policies, infrastructure addresses, constructor inputs and relevant creation
bytes. Profile factory construction fixes the validator and hook. Kernel
initialization and clone creation bytes also enter CREATE2.

Build, artifact and identity-manifest metadata carry the fixed descriptive
marker `addressDerivationMode: 'portable'`. It is absent from account configuration.
Manifest readers require explicit paths, the current marker, current artifact
hashes and recorded factory-address bindings. Profile configurations live at
`manifest.profiles[name].config`. Unknown artifacts, changed creation bytes,
contradictory metadata, inconsistent chains and changed factory bindings reject.
Where identities are recorded, readers compare the complete prediction and the
independent backend result.

Offline consistency checks do not prove a deployment exists. Preparation and
deployment commands also inspect actual runtime code and immutable values.
Use named exports such as `PreparedTableValidator` and `ProfileAccountFactory`
from `@cardano-on-evm/contracts`, and its current `manifest`.

## Executable example

```sh
npm run build:contracts
npm run build
node node_modules/tsx/dist/cli.mjs --conditions=development examples/portable-addresses.ts
```

The [complete example](../examples/portable-addresses.ts) generates a public test
key, supplies synthetic infrastructure addresses and compares chains 31337 and
31338 for general and experimental-general accounts. It checks address inputs
and enrollment-hash separation without sending a transaction. Replace its
synthetic infrastructure with verified deployments before operational use.

```ts
import { deriveProfileIdentity } from '@cardano-on-evm/sdk';
const first = deriveProfileIdentity(publicKey, headers, general);
const second = deriveProfileIdentity(publicKey, headers, { ...general, chainId: 31338 });
assert.equal(first.account, second.account);
assert.equal(first.accountSalt, second.accountSalt);
assert.notEqual(first.configHash, second.configHash);
```

## Reproducible validation

`fixtures/address-derivation-v1/` contains generated test inputs and separately
frozen protocol/backend known answers. Its provenance records compiler settings,
source input hashes and nine selected contract ABI/creation/runtime identities.
The test matrix includes every profile/policy variant, key subgroups, header
length boundaries, namespace/index limits and address-affecting inputs. Expected
values are read from the checkpoint; test execution does not regenerate them.

```sh
node node_modules/tsx/dist/cli.mjs --conditions=development scripts/experiments/address-two-chain.ts \
  --anvil .local/tools/foundry/anvil --out .local/my-fresh-address-run --port-base 20630
python3 scripts/check-clean-source.py --out .local/my-fresh-core-run \
  --anvil .local/tools/foundry/anvil --python /path/to/pinned/python --port-base 18500
```

The two-chain regression requires eight deployment rows: general, targets,
selectors and experimental-general on each of chains 31337 and 31338. Each row
compares SDK, independent backend, factory prediction and actual deployment.
Four replay cases require validator-level destination-chain failure with nonce
and authorization controls, followed by a correctly signed positive control.

Pinned Kernel's Solady EIP-712 constructor caches chain ID in runtime immutables.
The local regression executes only that constructor in a common chain context,
then restores and checks the distinct chain IDs before enrollment, account
prediction/deployment and operations. It compares complete infrastructure/runtime
bytes, including immutables. This is a controlled local prerequisite, not a claim
that arbitrary deployed infrastructure has identical runtime code.

The full-core harness runs this example, the independent matrix, two-chain
checks, isolated six-tarball consumption, HTTP/browser regressions and bytecode
pin rejection from Git-selected source inputs. Reports record actual commands,
results and source/artifact hashes. A source inventory identifies an uncommitted
worktree without inventing a commit identity. Consult a completed current run
report for pass/fail evidence; generated fixtures are not public-chain acceptance.
