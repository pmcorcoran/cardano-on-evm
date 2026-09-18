# TypeScript integration, version 0.1.0

Five ESM libraries ship compiled JavaScript, `.d.ts` declarations, source and
licenses. A sixth package contains the current contract artifacts and source. Node >=22.18 is required for the supplied backend/SQLite example.
Browser bundlers can consume the wallet, protocol, SDK and submission libraries.
The SDK never imports or installs the supplied private bundler.

Build all six local 0.1.0 packages with `npm ci --ignore-scripts`,
`npm run build:contracts` and `npm run build`. Then run
`node scripts/check-package-install.mjs --out .local/my-fresh-consumer` to pack,
install and verify all six together in an isolated consumer. A downloaded library
bundle contains its six exact tarballs, installation metadata and this consumer
script; `--archives /path/to/archives` verifies those supplied bytes without a
workspace or rebuild. No project package is fetched from a registry.
| Package | Main APIs and replaceable boundary |
| --- | --- |
| `@cardano-on-evm/wallet` | `connectWallet`, `connectLace`, `connectEternl`, `CardanoWalletError`, wallet types, `parseCardanoAddress`, `verifyCip8Signature`, canonical CBOR and byte helpers |
| `@cardano-on-evm/protocol` | `deriveProfileIdentity`, `profileConfigHash`, policy encoders, `Operation`, `Call`, encoding/hash/signature helpers |
| `@cardano-on-evm/enrollment` | `createProfileEnrollmentService`, `createEnrollmentHandler`, `ChallengeStore`, `MemoryChallengeStore`, independent backend derivation |
| `@cardano-on-evm/enrollment/sqlite` | `SqliteChallengeStore`, separate Node-only entrypoint |
| `@cardano-on-evm/sdk` | `enrollCardanoAccount`, `httpEnrollmentTransport`, `accountFromVerifiedKey`, `accountPreparation`, `accountFactory`, `constructOperation`, `signOperation`; reexports protocol and Lace connector |
| `@cardano-on-evm/contracts` | Nine named contract artifacts and the current build `manifest` |
| `@cardano-on-evm/submission` | `Rpc`, `httpRpc`, `createPublicBundlerAdapter`, `createPrivateBundlerAdapter`, `createDirectAdapter`, `Submission`, `Inclusion` |

## Configure and enroll

`ProfileIdentityConfig` contains `profile`, `chainId`, `entryPoint`,
`kernelImplementation`, `tableFactory`, `validatorCreationCode`,
`profilePreparationFactory`, `profileFactoryCreationCode`, `policy`,
`policyConfig`, `policyCodeHash`, `namespace` and bigint `index`. Infrastructure
addresses, code and immutable bindings must come from a verified deployment.
Derivation is portable for every supported profile. `CardanoAccount.config`
is a frozen, read-only `ResolvedAccountConfig` containing the configuration
snapshot. Chain ID is required for enrollment and operation signing/submission.
Configurations carrying the unsupported `addressDerivationMode` property reject
before wallet signing, even when its value is `portable`.

Use `PreparedTableValidator.bytecode` and `ProfileAccountFactory.bytecode` from
`@cardano-on-evm/contracts` for creation bytes, together with verified current
factory addresses. Its `manifest` records exact source/artifact identities.
The executable [portable address example](../examples/portable-addresses.ts) and
[manifest verification rules](address-derivation.md) describe these inputs.
Changing those inputs can create another account; [the complete derivation and
policy configuration](policies.md) describes their effects. JSON manifests encode
`index` as a decimal string; convert it to bigint on loading.

Configure one backend service per application/account scope:

```ts
import { createProfileEnrollmentService, createEnrollmentHandler }
  from '@cardano-on-evm/enrollment';
import { SqliteChallengeStore } from '@cardano-on-evm/enrollment/sqlite';

const store = new SqliteChallengeStore('./private/challenges.sqlite');
const service = createProfileEnrollmentService({
  application: 'https://app.example', cardanoNetwork: 0, config, store,
});
const handler = createEnrollmentHandler(service);
// Mount this Fetch handler at POST /challenge and POST /enroll.
```

The host supplies TLS, same-origin policy, rate/concurrency limits and lifecycle
cleanup. `POST /challenge` accepts only `{address}`. `POST /enroll` accepts only
`{id, signature, key}`. Unknown properties reject; application metadata belongs
outside those bodies. All scope comes from the server's configuration. A custom
`EnrollmentTransport` can map application routes to these methods; when using
`httpEnrollmentTransport`, pass a trailing slash if routes live below a prefix.
The supplied Fetch handler matches root paths, so prefix mounting must rewrite
the pathname before dispatch.

Enrollment configuration hashes use
`cardano-kernel:identity:v1:profile:portable` or
`cardano-kernel:identity:v1:experimental-general:portable`, with chain ID and the
complete ordered configuration. A backend and SDK configured with different
chains or configurations reject at the challenge consistency check before
`wallet.signData`. Equal account addresses do not authorize cross-chain
enrollment or operation replay.
In the browser, after displaying the selected profile's permanent powers:

```ts
import { connectWallet, enrollCardanoAccount, httpEnrollmentTransport, type CardanoWalletInjection }
  from '@cardano-on-evm/sdk';

const injection: CardanoWalletInjection = window.cardano ?? {};
const wallet = await connectWallet(injection, 'eternl', 0);
const addresses = await wallet.addresses('stake');
// Display the addresses and use the user's explicit choice as selectedAddress.
const account = await enrollCardanoAccount({
  wallet, transport: httpEnrollmentTransport('https://app.example/'),
  application: 'https://app.example', cardanoNetwork: 0,
  credential: 'stake', cardanoAddress: selectedAddress, config,
});
console.log(account.identity.account); // Predicts before deployment.
```

Declare the application's `window.cardano` injection type using the exported
`CardanoWalletInjection` type (`Partial<Record<CardanoWalletId, Cip30Provider>>`).
`CardanoWalletId` is `'lace' | 'eternl'`. The wallet and SDK packages both export
the connectors, `Cip30Api`, `Cip30Provider`, `CardanoWalletAdapter`,
`ConnectedCardanoWallet`, credential/network types and `DataSignature`.
`connectLace(injection, network)` retains its original call shape;
`connectEternl(injection, network)` selects Eternl. Only the requested provider
is enabled. `ConnectedCardanoWallet.apiVersion` is the provider's CIP-30 version,
not its extension release. Payment and stake selection are explicit; generated
fixtures cover both credential types and supported CIP-8 encodings. A backend result
must match the SDK's complete independent prediction and verified Cardano key.

Stores expose `put`, `get` and atomic `consume(id,payloadHex,now)`. `consume`
must compare the payload, enforce expiry and delete once in one transaction.
Memory storage is single-process. SQLite supports separate processes using the
same local database file; a replicated database adapter needs its own atomic
implementation. Prune expired records periodically. Never return enrollment
success before consumption succeeds. Challenges are not long-term sessions.

## Prepare, fund and create the account

`accountPreparation(account)` returns `{to,data,value:0n}` for the permissionless
profile/table preparation transaction. A service pays for that transaction and
gains no account authority. Check its receipt and the predicted factory/validator
runtime and immutable inputs. If already prepared, use the existing deployment.

Fund the predicted address for native transfers. Separately prefund its
EntryPoint deposit with `depositTo(account.identity.account)`. The tested
first-operation path uses a deposit; relying on the account to pay a
missing prefund during validation is outside the passing configuration.
The account can be funded before its code exists. Use only verified predictions.

Read `EntryPoint.getNonce(account,0)` and `eth_getCode(account)`. Construct with
`deploy:true` only when code is absent; the SDK supplies the profile factory and
its deterministic `factoryData`. The first authorized operation then creates and
executes the account through EntryPoint. Later operations use `deploy:false`.
See the runnable [reference app](reference-app.md), local full path in
`scripts/experiments/sdk-flow.ts`, and [enrolled-account preparation example](../examples/prepare-enrolled-account.ts).
The latter requires explicit enrollment, profile-manifest and profile inputs.
Sending additionally requires an infrastructure manifest, transaction journal
and an operator-owned submitter key.

## Review, sign, submit and observe

```ts
import { constructOperation, signOperation } from '@cardano-on-evm/sdk';
import { httpRpc, createPublicBundlerAdapter } from '@cardano-on-evm/submission';

const operation = constructOperation(account, {
  nonce, deploy: !deployed, calls, // {target, value: bigint, data: Hex}[]
  gas: { verificationGasLimit: 500000n, callGasLimit: 250000n,
         preVerificationGas: 100000n },
  fees: { maxFeePerGas: 50000000n, maxPriorityFeePerGas: 2000000n },
});
// Present chain, account, every call/value, profile powers, gas cap and route.
const signed = await signOperation(account, operation, wallet);
const context = { chainId: config.chainId, entryPoint: config.entryPoint,
                  operation: signed.operation };
const adapter = createPublicBundlerAdapter(
  httpRpc(bundlerUrl, { minimumIntervalMs: 3500 }),
);
const submission = await adapter.submit(context);
// Persist context + submission BEFORE beginning status polling.
const inclusion = await adapter.status(context, submission);
```

The example gas and fee constants are illustrative inputs. Applications must
estimate and bound fees for their actual network, operation and header profile. Any changed signed field
requires a fresh review and signature. The SDK snapshots the operation before
asynchronous wallet calls, checks the enrolled address/network and verifies the
returned proof. It does not replace an application's confirmation screen.

For private submission, use `createPrivateBundlerAdapter(httpRpc(gatewayUrl,
{headers:{authorization: bearerValue}}))` on a trusted server. Keep the gateway
token and executor key out of the browser. Private admission settings do not
change account identity or the immutable onchain policy.

Direct submission accepts an ordinary Base RPC, a funded submitter address and
`sendTransaction({to,data}) => Promise<transactionHash>`. The callback signs and
sends an Ethereum transaction from the service's own EOA. The adapter verifies
the chain/hash, simulates `EntryPoint.handleOps` and sends that same call. The
EOA funds the outer transaction; EntryPoint charges the account deposit for the
authorized operation and compensates its beneficiary. This EOA does not become
the account's Cardano root. Persist transaction nonces/hashes and serialize sends.

`status` returns `pending`, `included`, `execution-reverted` or
`transaction-reverted`. An outer successful transaction can contain a failed
operation. Acceptance requires the matching EntryPoint event, sender, nonce and
operation hash. Reobserve the same hash after timeouts; do not blindly create
another operation. For Base preconfirmation/reorg handling, require a nonzero
block hash that agrees with an ordinary-RPC mined block, as implemented by
`scripts/lib/canonical-receipt.ts`. A mined receipt is not a finality guarantee;
applications choose their confirmation depth.

Each adapter call captures the operation and context present when it is invoked,
before any asynchronous RPC work. Status calls likewise capture the submission
hashes. Direct adapters retain their RPC, submitter and sending callback; HTTP
transports retain their headers, timing and fetch configuration. Construct a new
adapter or transport to change those settings. Caller edits during an RPC wait
cannot change the submitted destination or the reported operation.

Switching adapters leaves the signed operation and identity unchanged. Once an
operation consumes its nonce, a second route cannot execute it again. Unsponsored
operations are fully supported. A custom paymaster may add fields before review
and signing; no particular sponsor is required. A paymaster integration requires separate testing.

## Wallet changes and extension points

When Lace or Eternl changes network, account, credential or protected-header format, discard
the pending review and enroll the intended identity again. Keep previous account
records accessible; another key/header/configuration can predict another address.
Switching wallets or reconnecting also requires fresh enrollment. The same
Cardano key can produce different Base accounts if wallets emit different exact
protected-header bytes. No automatic account portability or migration is promised.
Never silently move balances or replace the Cardano key. General root authority
can administer Kernel modules; permanent restricted profiles intentionally have
no owner/admin escape, upgrade or key rotation route. Recovery and migration
require separately designed profiles and user-authorized asset movement.

`CardanoWalletError` preserves standard CIP-30 `code`, original `cause` and
`reconnectRequired`. Account-change (-4) and access-refused (-3) errors invalidate
the adapter; call a connector again explicitly. Signing-declined (3) allows retry
with a valid current review. Browser applications serialize wallet requests and
discard stale results after a selection change.

Implement another `CardanoWalletAdapter` for wallets using the same tested CIP-8
subset, another `ChallengeStore` for storage, another `Rpc`/submission adapter
for transport, or `ICallPolicy` for a new immutable policy. Each extension needs
its own compatibility and authority tests. See [security](security.md),
[policy limitations](policies.md) and the [service extension map](../infra/bundler/README.md).
