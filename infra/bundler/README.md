# Private bundler service

This independently installed service runs pinned Alto 0.0.21 behind a Node HTTP
admission gateway. The account contracts, enrollment packages and SDK do not
import or install it. Its initial `0.1.0` validation uses generated Cardano test
keys and fresh local general, target-allowlist and selector-allowlist accounts.
Installed and source-built workers each execute the SDK/backend-to-Alto-to-
EntryPoint path with basic validation. Separate generated parser fixtures cover
strict mode's return decoding, signatures, nested calls, opcodes and storage.
These checks establish neither public-chain acceptance nor strict end-to-end
execution. Fresh run reports record the exact scope and outcomes.

## Install and run

Use Node 22.18 or later. From this directory:

```sh
npm ci --ignore-scripts
npm run prepare:worker
npm test
npm start -- --config=/absolute/path/service.json --secrets-file=/absolute/path/bundler.env
```

Start from `config/base-sepolia.example.json`. Set the two **deployed** simulation
addresses in `worker.entrypoint-simulation-contract-v7` and
`worker.pimlico-simulation-contract`. Deploy the selected worker's pinned
`EntryPointSimulations07` and `PimlicoSimulations` artifacts, and verify their
constructor inputs, runtime and immutable fields with
`scripts/experiments/verify-private-simulations.ts --deployment <report.json>
--rpc-url <url> --out <verification.json>`. The deployment report records its
chain ID, `workerBuild`, and each simulation's artifact path, address, transaction
hash, creation hash and runtime hash. The local validation runner produces this
format automatically. Replace the template's synthetic allowlist target with an
application target; configured upstream addresses are checked when the service
starts. Operators supply executor credentials and a gateway token through their
own secret file. Account owners authorize with their Cardano wallet.

The secret file contains references selected by the service config:

```dotenv
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
BUNDLER_EXECUTOR_PRIVATE_KEY=YOUR_FUNDED_TRANSACTION_SUBMITTER_KEY
BUNDLER_AUTH_TOKEN=YOUR_RANDOM_32_OR_MORE_CHARACTER_BASE64URL_TOKEN
```

Protect this file with mode 0600. Credentials are sent to the worker over IPC
and applied in its private process environment, not command-line arguments or
temporary configuration files. The worker receives no inherited telemetry or
Alto environment settings. Keep the executor separate from other transaction
senders to avoid nonce races; fund only the intended operational budget.

The gateway listens on loopback port 4337 and the worker on 4338. Both are
configurable. Run a TLS reverse proxy on the same host for remote application
backends. Expose only the gateway; a browser should call its application's
backend, which holds the gateway token. Do not embed the token in browser code.
The localhost signing lab uses a separate origin/port.

```ts
const adapter = createPrivateBundlerAdapter(httpRpc(privateRpcUrl, {
  headers: { authorization: `Bearer ${serverOnlyToken}` },
}));
const submission = await adapter.submit({ chainId, entryPoint, operation });
const inclusion = await adapter.status({ chainId, entryPoint, operation }, submission);
```

SDK imports come from `packages/submission`; the separately installed service
does not need these packages. An `execution-reverted` receipt means EntryPoint
charged gas and consumed the nonce but the account's call failed. It is distinct
from an invalid signature rejected before inclusion. Both are checked locally.

## Configuration and customization

| Area | Supported configuration / boundary |
| --- | --- |
| Network | Explicit chain ID, EntryPoint and runtime hash; RPC URL via an environment reference. Changing network requires restart. |
| Access | Required bearer token, loopback listener, bounded body, global token rate and concurrency limits. Use separate instances/tokens for isolated applications. |
| Admission | `open` or canonical Kernel CALL/batch target/selector/value rules; optional sender/factory/paymaster lists. Empty data has an explicit rule. This is service admission, not account authority. |
| Gas and fees | Gateway verification/call/total gas, max fee and maximum operation cost; Alto bundle gas, executor fee ceilings, estimation multipliers and retry settings. Estimates do not authorize higher fees. Re-sign changed operations. |
| Simulation | Alto safe mode by default; explicit documented basic-mode deviation supported. Dangerous skip-validation, automatic simulation deployment and debug endpoints are disabled. |
| Scheduling | Upstream bundle intervals/mode, mempool parallel/queued limits, unique senders and executor count. Custom scheduling algorithms require an upstream fork. |
| Submission/retries | Separate executor key, provider/fees, bounded resubmits, stuck timeouts and gas multipliers. This runner supplies one ordinary RPC URL; upstream multi-provider transaction transport requires a reviewed runner extension. |
| Sponsorship | Standard optional paymaster fields can be admitted by configuration. No paymaster is required. Supplying a sponsor never supplies a Cardano authorization. |
| Logging/metrics | JSON gateway decisions omit signatures, calldata and tokens; sanitized worker logs. `logging.level` accepts info/warn/error/fatal. Authenticated gateway `/metrics` exposes counters/config revision; Alto's worker metrics stay private. |
| Scaling | Upstream Redis receipt cache/queueing options are available. This supplied deployment has one worker and an in-memory queue; production durable queue/recovery and multi-host coordination need separate operating validation. |

Only supported non-secret Alto CLI options belong under `worker`; consult the
CLI help for this pinned version. Secret transport, EntryPoint, logging and RPC
method selection are controlled by the runner. The worker's CLI entry must be
used: importing its handler/options directly encounters an upstream circular
dependency. `src/worker.mjs` handles this without an upstream patch.

Edit the config atomically and send **SIGHUP to the runner**, not its worker, to
replace admission/rate/gas limits. Invalid reloads retain the previous config.
Network, worker and credential changes require restart. In-flight requests retain
their captured admission revision; changing admission does not cancel an already
queued signed operation. To quiesce a service, stop accepting submissions and
wait for tracked operations before stopping it.

The local experiment replaces the counter allowlist with an open rule without
changing any contract. Both target and selector policies receive the same
prohibited, validly signed operation after admission is relaxed. It reaches
EntryPoint and reverts in the immutable hook. A corrupted Cardano signature is
rejected by Alto and independently by the deployed validator. Receipt and call
trace checks distinguish signature validation from policy rejection, account
state changes and gas charges. Relaxing admission cannot
install a new root, remove the account policy or alter the signed operation.

To implement a new service admission policy, extend the `validatePolicy` /
`admitOperation` boundary and gateway tests, or replace the gateway while keeping
the standard ERC-4337 transport. A contract policy is a separate interface in
`contracts/policies/ICallPolicy.sol`; bundler customization never changes it.

## Validation modes and observed limits

The shipped template sets `safe-mode: true` and API version v2 (including
preVerificationGas checks). Strict mode needs a node capable of executing Alto's
JavaScript tracer. The local harness explicitly selects basic validation:
it retains EntryPoint signature simulation and onchain validation but disables
ERC-7562 opcode/storage admission. Full JavaScript tracing has provider and
timeout constraints and is not claimed by this local execution gate.

The pinned `PimlicoSimulations` ABI returns its result. EntryPoint's inner
`DelegateAndRevert` is distinct from that outer return. The supplied patches
expose the tracer context's outer output/error and
decode the matching function result. Signature, time, opcode and storage checks
remain in place. `tests/fixtures/strict-validation.json` is deterministic test
data generated from that pinned ABI and synthetic addresses, without wallet or
RPC captures. Actual `SafeValidator` and parser code reject outer reverts,
missing results, invalid signature data, banned opcodes, foreign storage,
undeployed references, changed code hashes, forbidden EntryPoint calls and
value transfers. Installed and freshly rebuilt workers execute the same cases.
`scripts/export-strict-validation-fixture.mjs --check` verifies reproducibility;
tests consume the checked-in fixture without regenerating expected values.

Alto's RPC timeout is currently internal to its transport, not a supported CLI
setting; changing it requires a pinned upstream patch and regression testing.
Read the current upstream [validation scope rules](https://eips.ethereum.org/EIPS/eip-7562)
and [Alto source](https://github.com/pimlicolabs/alto) alongside this pinned version.

## Shutdown and operation recovery

SIGTERM/SIGINT closes the gateway, terminates the worker and records a lifecycle
event; a bounded shutdown kills an unresponsive child. Local evidence verifies
both ports are closed. The runner closes the gateway and exits unsuccessfully
if its worker exits unexpectedly, allowing `Restart=on-failure` supervision.
`GET /health` is minimal liveness; authenticated `eth_supportedEntryPoints` and
chain/runtime preflight establish the initial worker readiness. Monitor the
lifecycle file and worker errors for continuing availability.

Persist each returned UserOperation hash in the application. After a timeout,
query its receipt/hash before retrying. Never manufacture a new signature or nonce
to recover an ambiguous send. Alto's default memory queue is not durable across
restart. Query the chain for the exact operation and account nonce before
resubmitting the unchanged signed operation. A transaction already broadcast may
still mine after the service stops; shutdown cannot revoke wallet consent.

## Source, modifications and maintenance

`upstream.json` pins the source commit, archive SHA-256, npm integrity and all
submodule commits. `scripts/fetch-source.mjs` retrieves the corresponding source;
`scripts/prepare.mjs --source=/absolute/source/path` applies the same recorded
patches to a source tree. The three upstream modifications bind the worker to
loopback, expose the outer strict-trace result, and decode the pinned simulation
return ABI. Original whole-file hashes and exact edits are checked; unrelated,
partial or ambiguous modifications are rejected. The source build also applies two erased TypeScript annotations in the loopback
patch for locked Fastify/Pino types. It retains strict compiler checking. Exact
compiler remappings and all ten submodule archives are pinned; nine rebuilt
Solidity artifacts match the published creation and runtime bytecode.

From the repository root, after installing the runtime and applying its patches:

```sh
npm ci --ignore-scripts --prefix infra/bundler/build-tools
node scripts/install-foundry.mjs
node infra/bundler/scripts/fetch-source.mjs
FORGE_BIN=.local/tools/foundry/forge node infra/bundler/scripts/build-source.mjs
node scripts/check-private-source.mjs --out .local/private-source-check
```

Use an absolute `FORGE_BIN` if invoking the builder from another directory.
The builder replaces vulnerable upstream pnpm 8 with npm-locked tools and uses
Solc-js 0.8.17/0.8.23/0.8.28 through Forge 1.8.1. It emits the complete JavaScript,
declarations, simulation artifacts and a SHA-256 inventory in
`.local/source-build-manifest.json`. Set top-level `workerBuild` to
`source` to run that build, or `package` (default) to run the patched npm worker.
Source startup verifies the generated files and runtime lock against its local
build record. This choice is fixed until restart. The wrapper accepts neither
an arbitrary module path nor a worker selected by an RPC caller.

`check-private-source.mjs` starts its own Anvil on port 18798 by default (change
the base with `--port-base`). It runs generated strict parser cases against both
worker builds, then executes fresh enrollment/deployment/call/batch flows,
both policy rejections, simulation bytecode/immutable verification and unexpected
child shutdown. Its final cleanup stops Anvil. The generated full flow explicitly
uses basic validation; reports identify strict parser coverage separately. This command
updates local experiment reports; run it in a disposable checkout if retaining
an existing local Anvil report set. For a complete isolated clean install/build
and both package/source worker checks, run from the repository root:

```sh
python3 scripts/ci/run-bundler.py --out .local/bundler-check
```

Use a fresh output directory. The harness exports its source through ordinary
Git add and checkout-index, verifying inventory hashes and executable bits before
building. It retains source/patch/build identities, separate
basic execution and generated parser reports, and failure logs. It denies
public RPC during validation and removes its owned processes and staged source.
See the
[CI/CD runbook](../../docs/github-cicd.md) for the outer current-run evidence
wrapper required by candidate workflows.

New gateway/runner code is MIT. Alto is GPL-3.0-or-later; its license is retained
in `LICENSE.Alto`. Distributing an Alto binary or modified image carries its
source/license obligations, including these patches and the corresponding build
inputs. Do not represent the full worker dependency tree as MIT.

The separately installed dependency tree has its own security audit. Record
current findings with the run and review upstream Fastify/router, OpenTelemetry
and other transitive dependencies when assessing exposure. The supplied gateway
constructs its own JSON HTTP request, forwards no external content-type/proxy
headers, disables CORS/debug methods, and isolates the worker on loopback;
telemetry and Redis are inactive. These reduce exposure but do not resolve all
upstream advisories or make this a hardened production release. Review the audit
findings and perform dependency upgrades with the service integration tests.
Core packages have a separate lockfile/audit and do not inherit Alto at install.
