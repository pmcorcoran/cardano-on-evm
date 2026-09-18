# Handover and operating responsibilities

The initial `0.1.0` delivery is local source and tested package/artifact output.
[Acceptance](acceptance.md) defines current run evidence; [requirements](requirements.md)
preserves the broader product requirements. No vendor engagement, independent
audit, hosting agreement or support SLA is implied.

## Release artifacts and evidence

Use the outputs from a fresh [acceptance run](acceptance.md) only after every
required gate passes. The core output contains six exact tarballs, the source
archive, current contract artifacts and reports recording their checksums.
Verify those checksums and the final isolated consumer report. Source inventory
hashes identify uncommitted source without inventing a commit. Keep credentials
outside the delivery; provide them through the operator's secret management
process.

The local task does not publish, tag or deploy to a public network. Future
GitHub release operation follows the separate [operator runbook](github-cicd.md)
and its security, provenance and maintainer approval gates. Generated wallet,
parser and loopback fixtures do not prove real-wallet or provider acceptance.

## People and ownership after delivery

| Role to assign | Responsibilities |
| --- | --- |
| Application maintainer | Enrollment application scope, durable challenge/session/operation stores, TLS/authentication, wallet change UX, funding and allowed-recipient configuration |
| Solidity/cryptography maintainer | Verifier and policy review, source/build pins, test vectors, deployment/runtime/immutable checks, new-version migration design |
| Infrastructure operator | RPC/tracer capacity, executor funds and nonce isolation, gateway token rotation, dependency patches, queues/backups, availability and incident response |
| Release maintainer | CI, license/source inventory, reproducible artifacts, version tags, package publication and requirements reconciliation |
| Wallet holder/test participant | Review and sign enrollment/operation payloads; no Cardano secret-key export; verify the displayed permanent policy before enrollment |
| Independent security reviewer (optional engagement) | External cryptographic and complete-account review under a separately agreed scope, fee and retest plan |

These are required capabilities and responsibilities, not named staff or agreed
post-delivery commitments. One person may cover several roles; the independent
audit should use reviewers separate from the implementation work. There is no
24/7 support commitment. Agree issue triage, patch windows, release authority and
an escalation contact before operating a production application.

## Itemized implementation estimate

The table is an internal estimate of professional effort to reproduce and hand
over this scope. It is not recorded labor, an invoice, or a supplier quote. The
assumed blended engineering rate is **USD 125–200/hour**, excluding taxes. It
includes internal review and functional acceptance, but excludes an independent
audit, production hosting and optional features. Existing source reduces a new
integrator's effort; do not bill this baseline as work still outstanding.

| Workstream | Estimated hours | Estimated USD |
| --- | ---: | ---: |
| Architecture, wallet/protocol feasibility and measured experiments | 80–160 | 10,000–32,000 |
| D1 wallet, scoped enrollment, storage and independent identity | 60–100 | 7,500–20,000 |
| D2 verifier, preparation and Kernel/factory integration | 160–280 | 20,000–56,000 |
| D3 SDK and three independent submission adapters | 60–100 | 7,500–20,000 |
| D4 permanent target/selector policies and authority model | 60–100 | 7,500–20,000 |
| D5 private service, configuration, patches and lifecycle | 80–140 | 10,000–28,000 |
| Reference app, documentation and reproducible packaging | 100–160 | 12,500–32,000 |
| Negative tests, real-wallet acceptance and internal security review | 120–200 | 15,000–40,000 |
| Total baseline | 720–1,240 | 90,000–248,000 |

For an independent maintainer taking over the current release, budget another
40–80 hours (USD 5,000–16,000 at the same assumed rate) for local reproduction and
artifact review (12–24h), application/environment integration (8–16h), security
and authority review (16–32h), and release/access handover (4–8h). This is a
planning allowance, not a claim that these checks already passed or a firm delivery
date. Wallet availability, RPC behavior and publication access affect elapsed time.

For adoption of this existing implementation, an indicative schedule is one to
two working weeks with one coordinating integration/release engineer and scheduled
help from the contract/cryptography maintainer and infrastructure operator. This
uses the 40–80-hour allowance above; it does not restart the completed milestones
or assume an agreed staff assignment.

| Sequence after access is available | Estimated effort | Responsible capability / dependency |
| --- | ---: | --- |
| Days 1–3: reproduce the release and inspect source, manifests and licenses | 12–24h | Release/integration engineer; build host and package/RPC access |
| Days 3–5: configure the host application and wallet workflow | 8–16h | Application maintainer and operator; wallet holder and test funding |
| Days 3–8: review authority, cryptography scope and operating limits | 16–32h | Contract/cryptography maintainer with operator; follows reproducible inputs and can overlap integration |
| Final 1–2 days: record acceptance, publish and hand over access/runbooks | 4–8h | Release owner; approved public repository destination/access |

These are planning windows, not committed delivery dates. Reproduce the exact
initial-release artifacts and separately authorize any public acceptance or
publication. An optional independent audit has a separate 6–10-week planning
allowance below and is not included in this adoption schedule.

## Operating costs

Provider, RPC/tracer, hosting, storage, monitoring, TLS and network gas prices
must be quoted for the chosen operating environment. A planning reserve of
USD 50–300/month for infrastructure is an internal assumption, not a tested
capacity bound or vendor quote. A self-hosted chain node requires separate sizing.
Gas for permissionless table preparation, profile/account deployment, EntryPoint
deposits, native transfers and outer submitter transactions must be budgeted
separately using current simulation and fees. No exchange rate is assumed.

Allow 20–40 maintainer hours/month (USD 2,500–8,000 at the assumed rate) for
monitoring, dependency review, wallet/provider compatibility checks and releases.
A routine upstream Alto change may require another 16–48 hours for patch rebase,
source/artifact reproduction, tracer tests and all-route canaries. A major
EntryPoint, Kernel or cryptographic change requires a new estimate and security
review. These allowances are not a support contract.

## Optional work and independent audit

All figures below are internal estimates using USD 125–200/hour unless stated.
They are additional scope and are not implemented merely because an extension
point exists.

| Optional extension | Estimated hours | Estimated USD / boundary |
| --- | ---: | --- |
| Additional software CIP-30 wallet adapter and real acceptance | 32–64 each | 4,000–12,800; wallet/version/credential coverage must be tested |
| Hardware-wallet signing compatibility | 64–120 | 8,000–24,000; device/app restrictions may prevent this payload |
| Replaceable paymaster adapter and sponsorship example | 40–80 | 5,000–16,000, plus sponsor funding/provider fees |
| Additional stateless recipient/value/time-window policy | 24–60 | 3,000–12,000 |
| Stateful cumulative spending limits | 96–160 | 12,000–32,000; requires a new hook and accounting/bypass tests |
| Recovery or Cardano key rotation | 120–240 | 15,000–48,000; new authority model/profile, migration and independent review |

Permanent profiles have no administrator or owner opt-out. Recovery, rotation
or less restrictive policies cannot be silently added to an existing permanent
account. A new profile changes deterministic identity, and moving assets remains
subject to the existing allowlist. General accounts permit Cardano-authorized
administration, but the release does not implement a recovery product.

An optional independent audit should include the Ed25519/subgroup/encoding and
SHA-512 implementation, immutable precomputation and factory, complete Kernel
validation/administration paths, policy and batch bypasses, enrollment/address
binding and replay races, SDK signing snapshots, receipt/retry handling, and the
private gateway plus the checksum-verified Alto patches. Include reproducible deployment inputs,
dependency/license review, an initial report, remediation review and retesting.

For planning only, two specialists for 6–10 weeks at 40 hours/week each imply
480–800 hours. At an assumed specialist rate of USD 200–350/hour, reserve
**USD 96,000–280,000**. Obtain binding quotes against a frozen source inventory (and commit when one exists) and stated
vendor/dependency boundaries; the new elliptic code can materially change scope.
This estimate is not an auditor's quote, and no audit result is claimed.

## Maintenance and handover checks

Before adopting a release, reproduce the lockfile build and local example, inspect
the [license inventory](../THIRD_PARTY_NOTICES.md), verify configured chain/code
and immutable bindings, and review the permanent authority terms. Repeat wallet
acceptance after wallet, Kernel, EntryPoint or verifier changes. A provider-only
change should leave identity unchanged; repeat receipt and portability canaries.

Retain the exact current source, artifacts and account configuration as
operational inputs for the accounts you deploy. Apply dependency updates first in an isolated
test deployment, rerun strict tracer and gateway tests, then the three-route live
canary with an explicitly funded test account. The [dependency review](dependency-review.md) records the coordinated runtime
remediation and its validation procedure. Fresh audits remain mandatory; the
other limits in [security](security.md) still apply.
