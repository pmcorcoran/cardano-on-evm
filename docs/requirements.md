# Requirements and validation mapping

The table below records the broader product requirements and retains their
original section identifiers. The initial local `0.1.0` release scope and
concrete gates are defined in [acceptance](acceptance.md).
Real-wallet sessions, named provider admission, public network deployments and
publication require separate operator acceptance; local generated data does not
claim those outcomes. Current pass/failure status belongs to source-bound run
reports. No old result is a substitute for executing a required current gate.

| ID | Requirement | Implementation | Required evidence |
| --- | --- | --- | --- |
| C1 | §1 Cardano control, no exported key or second owner key | wallet, contracts, SDK | real-wallet signed onchain execution; authority review |
| C2 | §1 services never acquire spending authority | contracts; threat model | hostile backend/submitter/sponsor tests |
| C3 | §1 Base Sepolia; mainnet procedures | deployment scripts, manifest, operations | live chain ID/code/receipts; mainnet runbook |
| D1.1 | §2 D1 unpredictable expiring challenge bound to application/address/chain/config | enrollment package | A1 scoped tamper, expiry, replay tests |
| D1.2 | §2 D1 CIP-30/CIP-8 adapter and working Lace | wallet package, reference app | wallet version, address type, real enrollment AND operation signatures |
| D1.3 | §2 D1 signature and address credential binding | CIP-8/address verifier | valid keys, mismatches, script/unsupported types, network tests |
| D1.4 | §2 D1 atomic successful consumption; replaceable store | enrollment handlers/store | concurrent requests: exactly one success |
| D1.5 | §2 D1 deterministic SDK/backend identity | SDK and independent backend derivation | A2 repeated enrollment, prediction/deployment/owner/config match |
| D1.6 | §2 D1 every derivation input and config-changing address documented | identity specification, vectors | independent vectors, changes to each input |
| D1.7 | §2 D1 fixtures, prediction/deployment examples, distinct challenges | fixtures, examples, payload specification | generated vs wallet provenance; cross-domain rejection |
| D2.1 | §2 D2 full wallet→bundler→EntryPoint→Kernel→Cardano-validator→call path | contracts, SDK, private service | A3/A4 real flow and receipts |
| D2.2 | §2 D2 pinned Kernel/EntryPoint/SDK/bundler; verified addresses/build | version manifest, vendored source/build | chain bytecode hashes, lockfiles, clean build |
| D2.3 | §2 D2 operation/context binding | authorization encoding, validator | key, mutation, nonce, account, chain, EntryPoint, encoding negatives |
| D2.4 | §2 D2 self-hostable private bundler, upstream modifications, status | infrastructure, adapter, docs | A4 runtime/receipt and reproducible source/config |
| D3.1 | §2 D3 private bundler independence | package boundaries | core-only clean install/build/test |
| D3.2 | §2 D3 separate private/public/direct adapters | submission package | deployment AND later execution in each mode |
| D3.3 | §2 D3 normal-RPC funded direct handleOps and receipt | direct adapter; funding runbook | A6 live deployment and execution, bundler stopped |
| D3.4 | §2 D3 named public provider ERC-7562/resource feasibility | public experiment/admission capture | A5 live provider deployment/execution, exact config/errors/receipts |
| D3.5 | §2 D3 compatible-account portability | reference app, portability script | A6 same account public/direct with private service stopped; owner/policy/balance invariants |
| D3.6 | §2 D3 compatible profiles/modes; no vendor identity | compatibility matrix, identity | matrix verified; endpoint swap leaves derivation unchanged |
| D3.7 | §2 D3 optional replaceable sponsorship and fees | adapter interfaces, operations | unsponsored path passes; provider fee source |
| D4.1 | §2 D4 arbitrary supported calls/transfers/batches | general profile | A7 representative successful calls/transfer/batch |
| D4.2 | §2 D4 configurable target/selector examples and extension interface | restricted profile/policies | allowed/disallowed calls in all modes |
| D4.3 | §2 D4 every enabled execution/admin path protected | root policy, locked administration | root/module/upgrade/batch/selfcall/delegate/executor bypass negatives |
| D4.4 | §2 D4 explicit creation authority and optional application admin | profile config and authority spec | no undeclared admin; documented opt-out/install/update/removal |
| D4.P1 | §2 D4 preferred additional policy discussion | policy extension guide | describe spending/transfer caps, recipients, time windows/limitations |
| D5.1 | §2 D5 network/EntryPoint/RPC/access/gas/fee/credential/log config | independent bundler infrastructure | config tests and running service |
| D5.2 | §2 D5 admission replacement/reconfiguration | admission gateway | A8 policy change without account change; hostile admission still rejected onchain |
| D5.P1 | §2 D5 preferred modular extension points | bundler docs/components | admission/simulation/queue/estimate/retry/paymaster/metrics map; fork limits/cost |
| DX1 | §3 public commercial-friendly source license | LICENSE, public repository | publicly accessible source URL; dependency notices |
| DX2 | §3 versioned contracts and documented TypeScript APIs | contracts, SDK, API docs | enrollment/prediction/create/construct/sign/submit/status examples |
| DX3 | §3 reusable backend and independent bundler | package manifests | replaceable interfaces; independent install/run |
| DX4 | §3 reference app | apps/reference | runnable enrollment/prediction/create/transfer/call/batch/mode/profile UX |
| DX5 | §3 deployment/locks/env/checks/release | scripts, CI, env templates | A9 clean-checkout full reproduction |
| DX6 | §3 funding/errors/wallet changes/upgrades/versions/troubleshooting | operations documentation | runbook exercised; limitations explicit |
| A1 | §4 Enrollment | enrollment + operator wallet session | all stated positives and negatives, concurrent/scope/network/encoding |
| A2 | §4 Identity | SDK/backend/factory | stable independent derivation + deployed owner/config |
| A3 | §4 Signatures | validator + actual Kernel path | valid and all invalid context cases incl wrong EntryPoint/enrollment signature |
| A4 | §4 Private bundler | private live demonstration | full enrollment-to-execution and status/receipt |
| A5 | §4 Public bundler | named provider live demonstration | deployment + later operation receipts |
| A6 | §4 Direct/portability | direct and portable live demonstration | direct deployment + public/direct same account, private stopped, invariants |
| A7 | §4 Policies | general and restricted live tests | allowed calls, batches, prohibition and all bypass cases in all modes |
| A8 | §4 Customization | replaced admission rule | behavior changes; onchain authority unaffected |
| A9 | §4 Reproducibility | release clean-room check | clean source build/test/deploy/examples; core without bundler |
| S1 | §4 performance | gas results and scripts | full-path first/subsequent calls/batches, deploy/validation/total gas; limits/config |
| S2 | §4 threat model/review | security model/findings | crypto/enrollment/replay/policy/admin review, findings fixes/retests; unaudited deps |
| S3 | §4 optional audit separately scoped/costed | handover budget | scope + estimate basis or quote requirement; no claimed external audit |
| P1 | §5.1 architecture/D1–5 support status | architecture package map | distinguish tested/proposed/assumed/unresolved |
| P2 | §5.2 technologies/reuse/licenses/upstream modifications | manifest, notices | immutable refs, license obligations, patch inventory |
| P3 | §5.3 signature/identity/public/direct/policy designs | protocol/architecture | executable experiments plus design evidence |
| P4 | §5.4 wallet/address/account coverage | compatibility matrices | exact tested versions, signing limitations, fallback behavior |
| P5 | §5.5 milestones/roles/itemized budget/ongoing costs | handover | explicit estimates/bases/unknowns; no invented commitments/prices |
| P6 | §5.6 testing/review/prior work/maintenance/handover | handover and security | responsibilities, forks/upgrades, agreed commitments only |
| P7 | §5.7 separate optional pricing | optional scope document | wallets/paymasters/advanced policies/recovery/rotation/audit estimates or quotes |
| M1 | §6 feasibility exit | experiments and evidence | real Lace, deterministic design, full verifier cost, public + direct viability |
| M2 | §6 core package | D1/D2/D4 | implemented + tested scope |
| M3 | §6 infrastructure | D3/D5 | three modes + customization + reference demonstrations |
| M4 | §6 release/handover | complete release/evidence | all mandatory rows reconciled to current evidence |

## Wallet extension requirements

The reusable Lace/Eternl adapter requirements are retained in
[wallet requirements](wallet-requirements.md), with [validation scope](eternl-acceptance.md).
Internal implementation notes and operator captures are not publication inputs.
