# Dependency review

The core, Alto runtime, and Alto source build tools use three independent npm
lockfiles. The security policy evaluates every severity with no dependency
exceptions. Audits are time-sensitive; rerun the commands below for each change.
This review is not an independent security audit or a guarantee of safety.

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
