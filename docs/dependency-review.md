# Dependency review

The core, Alto runtime, and Alto source build tools use three independent npm
lockfiles. The security policy evaluates every severity with no dependency
exceptions. Audits are time-sensitive; rerun the commands below for each change.
This review is not an independent security audit or a guarantee of safety.

## Deferred major upgrades

The following reviews retain the supported Node 22.18.0 floor and the pinned
Alto source. The package-specific major-version filters in
[Dependabot configuration](../.github/dependabot.yml) leave minor, patch, and
[security updates enabled](https://github.blog/changelog/2021-05-21-dependabot-version-updates-can-now-ignore-major-minor-patch-releases/).
They do not change the all-severity audit policy. Keep each filter until a
separate reviewed decision changes that policy; adopting one reviewed version
does not authorize future major upgrades.

- [Node types #1](https://github.com/pmcorcoran/cardano-on-evm/pull/1): the
  narrowly scoped replacement retains the original **24.3.1 to 26.6.1** proposal
  and the Node **22.18.0** runtime floor. The review and consumer coverage are
  described below. The major-version hold remains for future unreviewed updates.
- [TypeScript #12](https://github.com/pmcorcoran/cardano-on-evm/pull/12) and
  [#13](https://github.com/pmcorcoran/cardano-on-evm/pull/13): implemented together
  as the TypeScript **7.0.2** compiler migration described below. The major-version
  holds remain for future unreviewed compiler updates.
- [pyee #11](https://github.com/pmcorcoran/cardano-on-evm/pull/11): close as
  incompatible. Playwright 1.62.0 requires `pyee>=13,<14`; the resolver rejects
  the proposed pyee 14 combination. Revisit when a reviewed Playwright release
  supports pyee 14, regenerate the complete hash-locked Python 3.13 dependency
  set, and pass browser acceptance and the failure-capture regression.
- [App Token #16](https://github.com/pmcorcoran/cardano-on-evm/pull/16): defer
  while the version-workflow App is unconfigured. Configure a repository-scoped
  App with contents and pull-request write permission and a `version-pr`
  environment restricted to main, then set `VERSION_APP_ID` and the environment
  secret `VERSION_APP_PRIVATE_KEY` through GitHub settings. Never include the
  private key in review comments or evidence. Enable the controlled version
  workflow and verify the App identity, repository scope, coordinated version
  changes, and resulting PR's ordinary CI. Correct the stale action-version
  comment when upgrading. A skipped workflow does not validate the action;
  release publication must remain disabled. See the
  [version workflow](../.github/workflows/version.yml) and
  [CI runbook](github-cicd.md).

## Node declaration compatibility

The root development dependency changes from `@types/node` 24.3.1 to 26.6.1.
Its sole dependency changes from `undici-types` 7.10.0 to 8.9.0. Both packages
contain declarations; this does not install or replace Node's runtime Undici.
The minimum TypeScript version declared by the Node types rises from 5.2 to 5.6;
the minimum supported consumer compiler remains **5.9.2**. Root and Alto build
tools now use **7.0.2**, as reviewed in the coordinated migration below.

Newer declarations do not establish runtime compatibility. Review project
source, tooling, tests, and emitted declarations against the
[Node 22.18.0 API documentation](https://nodejs.org/download/release/v22.18.0/docs/api/).
The relevant boundaries are:

| Boundary | Node 22-compatible usage and coverage |
| --- | --- |
| Enrollment persistence | `DatabaseSync`, `exec`, `prepare`, statement `run`/`get`, and `close`; installed consumers exercise enrollment, wrong-payload rejection, one-time consumption, expiry and pruning |
| Crypto and byte handling | `randomBytes`, `createHash`, `createPublicKey`, `verify`, `timingSafeEqual`, and ordinary Buffer conversion/concatenation; frozen wallet vectors and independent Ed25519 checks retain their expected values |
| HTTP and Fetch | HTTP servers, Fetch requests/responses, body readers, abort signals, and JSON responses; HTTP/browser acceptance and adapter tests exercise these on their actual runtimes |
| Tooling and workers | File/path operations, child processes, signals, `parseArgs`, `parseEnv`, and the existing module network guard; fast checks and installed/source worker tests retain their supported interfaces |

The Node 26 declarations also expose APIs unavailable at the runtime floor,
including SQLite statement caches and authorizers, disposable temporary
directories, and configurable `Assert` instances. Their availability
to the compiler is not permission to use them. Keep the existing compatible
operations and require actual Node 22.18.0 execution when changing these paths.

`scripts/check-package-install.mjs` installs the same six archives in fresh
consumers using **22.18.0**, **24.3.1**, and **26.6.1** Node declarations with
both TypeScript **5.9.2** and **7.0.2**. It verifies the installed versions and
executed compiler versions, checks declaration
files without `skipLibCheck`, and runs the ESM/API, enrollment, signing and
SQLite checks for every consumer. Each consumer retains its lockfile, exact
declaration and Undici type versions, and logs in the report directory. This
also works from the standalone library bundle without a workspace manifest.

For this upgrade, perform clean installs, contract generation, type checking,
builds, units and CI regressions on Node **22.18.0**, **24.21.0**, and **26.8.1**.
Run the [full acceptance procedure](acceptance.md), including browsers and the
Alto source rebuild. Reuse the newly built `consumer/archives` directory for
the isolated consumer command on all three runtimes, comparing the six archive
hashes across reports. Record fresh all-severity audits for all three trees.
Historical checks on the closed proposal do not satisfy these requirements.

The Node declaration upgrade changes development declarations and validation
tooling. It preserves public APIs, engine floors, fixtures, vendored inputs and
Solidity compiler settings and does not require a package Changeset.

## Coordinated TypeScript 7.0.2 migration

Root and `infra/bundler/build-tools` pin exactly **7.0.2**, with locks generated
by **npm 11.19.0**. The only dependency changes are TypeScript and its exact native
platform dependencies. The separate Alto runtime lockfile is unchanged. Native
compiler packages remain optional platform selections in both complete lockfiles;
`npm ci --ignore-scripts` and the existing `tsc`/Node launcher commands are retained.
The root configuration explicitly selects Node types while retaining ES2022,
NodeNext, strictness, input coverage, declarations and output paths.

Alto's removed `node` module resolution is overridden with **bundler** resolution,
explicit Node types and `rootDir` pointing to its extracted `src` directory.
The ESNext target/module and `src/esm` layout are preserved. The existing
`tsc-alias` pass still rewrites aliases and completes JavaScript import paths.
`typescript7-yargs-type` imports `Argv` as a type and replaces the old
`yargs.Argv` annotation. The existing patch mechanism checks original source
hashes, rejects partial/tampered inputs and permits idempotent reapplication.
Its installed replacements are empty, so installed-worker JavaScript is unchanged.
Upstream source archives, submodule pins, vendored inputs and Solidity settings
are preserved.

Compatibility evidence is required for Node **22.18.0**, **24.21.0**, and
**26.8.1**, including clean installs, contracts, type checking with library checks
also enabled, builds, units, CI regressions and repository/vendor checks. The
consumer checker runs all six TypeScript/Node-declaration pairs on each runtime:
**5.9.2** and **7.0.2** × **22.18.0**, **24.3.1**, and **26.6.1**. Build one set of
six archives and pass the same `--archives` directory for all **18** consumers.
Every pair requires declarations with `skipLibCheck: false`, existing ESM/export,
enrollment, signing and SQLite checks, and exact local sibling archive integrity.

`package-install.json` records each executed compiler, installed Node/Undici
declarations, native platform package, archive hashes and consumer lock hash.
Each `typescript-VERSION-node-types-VERSION/` directory retains its own manifest,
lockfile and install/compiler/declaration/ESM logs. A later pair's failure leaves
the aggregate unsuccessful. The same checker works in a standalone library bundle
without a root workspace manifest. Focused regressions exercise the full loop,
its failure path and the source-only patch's idempotence/tamper rejection.

`artifacts/package-build.json` records the root compiler version and host platform.
Alto's `source-build-manifest.json` records its executed compiler and effective
`--showConfig` output alongside source, patch, lock and compiled-file hashes.
The fresh baseline comparison preserves emitted JavaScript and Solidity bytecode.
Package notices record the updated compiler. Declaration differences are quote formatting, property ordering
and equivalent `Address`/`Hex` aliases; compatibility checks must establish
unchanged public APIs/runtime behavior. A fresh Alto source build must reproduce
all nine creation/runtime bytecode pairs, resolve emitted imports, start its CLI
and pass installed/source worker regressions across supported Node runtimes.
The [acceptance procedure](acceptance.md) also requires browsers, local chains,
fresh all-severity audits of all three trees and complete license collection.
Local Linux ARM64 and GitHub Linux x64 must both install and execute the native
compiler. Historical checks and migration probes do not establish final acceptance.

No package version bump or Changeset accompanies this build-tool migration:
public behavior, interfaces and the Node **>=22.18.0** floor remain the acceptance
contract. Dependabot major holds and security/release policies remain in force.

## Coordinated runtime migration

On 2026-09-17, fresh audits found no root or build-tool vulnerabilities and 36
vulnerable runtime packages, including six high-severity findings. The runtime
migration keeps Alto **0.0.21**, commit
`228d2ee9a6833e07da7f82e2a9303c8e29d65b14`, its source archive checksum, all
Solidity submodules, compiler versions, settings, and expected bytecode intact.
Exact overrides are scoped to this separately installed service. Core packages
do not import or install Alto or its web/telemetry dependencies.

| Reviewed advisory | Patched selection |
| --- | --- |
| OpenTelemetry [baggage allocation](https://github.com/open-telemetry/opentelemetry-js/security/advisories/GHSA-8988-4f7v-96qf) | Core 2.11.0, beyond the 2.8.0 fix |
| OpenTelemetry [malformed Jaeger header](https://github.com/open-telemetry/opentelemetry-js/security/advisories/GHSA-45rx-2jwx-cxfr) | Jaeger propagator 2.11.0, beyond the 2.9.0 fix |
| OpenTelemetry [Prometheus exporter crash](https://github.com/open-telemetry/opentelemetry-js/security/advisories/GHSA-q7rr-3cgh-j5r3) | SDK/exporters 0.222.0, beyond the 0.217.0 fix |
| Fastify [web stream allocation](https://github.com/fastify/fastify/security/advisories/GHSA-mrq3-vjjr-p77c), [Content-Type bypass](https://github.com/fastify/fastify/security/advisories/GHSA-jx2c-rxcm-jvmq), [forwarded host/protocol spoofing](https://github.com/fastify/fastify/security/advisories/GHSA-444r-cwp2-x5xf), [primitive coercion mismatch](https://github.com/fastify/fastify/security/advisories/GHSA-w2qp-rph6-63g4) | Fastify 5.12.5, beyond every affected range, with CORS and WebSocket plugins 11.3.0 |
| find-my-way [HTTP/2 denial of service](https://github.com/delvedor/find-my-way/security/advisories/GHSA-c96f-x56v-gq3h) | Patched 9.x router selected by Fastify and frozen in the runtime lockfile |
| UUID [buffer bounds](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq) | Bull's dependency pinned to 11.1.1; CommonJS and v4 behavior retained |

The upstream advisory pages and npm advisory response were checked before
pinning. Exposure assessments are not used to waive findings. The exception
file remains empty, and the existing all-severity policy is unchanged.

The [Fastify 5 migration guide](https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/)
requires a custom logger under `loggerInstance`. Checksum-verified source and
installed patches make that change, retain loopback binding, use bounded metric
labels for unmatched routes, and make WebSocket plugin registration asynchronous.
A source-only annotation accurately describes the existing nullable request
decorator. JSON-RPC validation, gateway authentication, and strict simulation
checks remain active.

OpenTelemetry SDKs are aligned on stable 2.11.0 and experimental 0.222.0.
HTTP, Redis, Pino, and Undici instrumentation are migrated together. The old
Fastify instrumentation dependency is an explicit npm alias for the maintained
[`@fastify/otel` 0.21.0](https://github.com/fastify/otel); both Alto entrypoints use
its initialization hook to preserve Fastify 5 tracing. The direct alias ensures
source and installed workers resolve the same module. The Viem and legacy fetch
adapters retain their interfaces with the updated instrumentation base. Reviewed
[OpenTelemetry 2.x API changes](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/upgrade-to-2.x.md)
do not require changing Alto's sampler or OTLP exporter APIs.

[Sentry's 9-to-10 migration](https://github.com/getsentry/sentry-javascript/blob/develop/docs/migration/v9-to-v10.md)
aligns its OpenTelemetry dependencies with 2.x. Sentry 10.75.0 retains the
initialization, HTTP integration, error filtering, and capture APIs used by
Alto. No global major-version override is used for Fastify, Sentry or UUID.
The instrumentation-base override is validated with actual local trace export.

## Reproduce the checks

From the repository root, install each locked tree without lifecycle scripts:

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix infra/bundler
npm ci --ignore-scripts --prefix infra/bundler/build-tools
npm run prepare:worker --prefix infra/bundler
npm test --prefix infra/bundler
node scripts/collect-licenses.mjs
python3 scripts/ci/security.py audit --out .local/dependency-audit
node scripts/install-foundry.mjs
python3 scripts/ci/run-bundler.py --out .local/bundler-validation
```

Use a new output directory for every validation run. See the
[CI runbook](github-cicd.md) for pinned tool versions. The bundler harness exports
a clean source tree, reinstalls both worker dependency trees, fetches and verifies
preferred source, rebuilds TypeScript and all nine Solidity artifacts, and
requires creation/runtime bytecode equality. It runs the installed and freshly
compiled workers through gateway and strict-parser regressions, runtime
compatibility, local account/policy transactions, simulation bytecode verification,
and unexpected-worker-exit lifecycle checks. Generated deterministic strict
fixtures test decoding, signatures, nested calls, opcodes, storage and contract
references. Full strict end-to-end execution on a public node is not claimed;
local transaction execution uses explicitly declared basic validation.

The runtime regression uses the real Alto RPC server, including HTTP versions,
WebSockets, CORS, logger output, bounded metrics and loopback binding. It sends
telemetry only to a disposable local collector and Sentry only to an in-memory
transport, and tests Bull's CommonJS UUID use and rejection of undersized buffers.
The service runner still starts with a minimal environment and does not enable
operator telemetry implicitly. Redis deployment and multi-host operation still
require their own operating validation.

Patch evidence records the original and resulting file hashes, patch-definition
hash, and runtime lock hash separately for installed and source workers.
`licenses/supplemental/` supplies required notices missing from npm packages;
`node scripts/collect-licenses.mjs` rebuilds the full inventory and fails if any
installed package lacks a notice. See [third-party notices](../THIRD_PARTY_NOTICES.md)
and the [security limitations](security.md).
