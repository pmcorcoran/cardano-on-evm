# Operations and integration handover

Start with [deployment](deployment.md), [SDK APIs](sdk.md), and the
[reference application](reference-app.md). The account owner is the enrolled
Cardano key. Enrollment servers, RPC providers, bundlers, direct transaction
submitters and paymasters do not gain account authority from their service role.

## Funding and submission

Maintain separate budgets for permissionless key/profile preparation, each
account's EntryPoint gas deposit, its native transfer balance, and each EOA
executor's outer transaction gas. UserOperation gas fees reimburse a submitter
through EntryPoint; Base's outer transaction can also have a separate L1 data
fee. Maximum operation cost is the signed sum of verification, call and
pre-verification gas times maxFeePerGas, plus explicit paymaster gas if present.
The unsponsored reference cap is 0.0000425 test ETH. A failure during account
execution can consume nonce and gas while reverting all requested calls.

Public submission uses standard ERC-4337 RPC with a configured provider endpoint
or an implementer's compatible endpoint. Private submission uses the separately
installed [gateway and Alto worker](../infra/bundler/README.md). Direct submission
uses ordinary Base RPC and a funded EOA calling `EntryPoint.handleOps`. Direct
EOA credentials belong on the backend and never in the browser. A new operator
gets a separate local nonce journal; the journal path is explicit.

Sponsorship is optional. The protocol and adapter types support standard
paymaster fields; an application may supply a replaceable paymaster integration.
The local acceptance operations are unsponsored, and no hosted paymaster or sponsor
is required by derivation or signature verification. Sponsor gas/data must be
final before wallet review/signing. A sponsor can refuse payment or constrain
its subsidy; it cannot authorize a different call. No live sponsored path or
specific paymaster contract is claimed. See [handover costs](handover.md) for
operating-cost assumptions and separately estimated sponsor integration work.

## Submission errors and recovery

| Observation | Action |
| --- | --- |
| Challenge expired, replayed or session lost | Issue a fresh challenge for the same explicit address/configuration. Identical derivation inputs preserve the account address. |
| Wallet address, credential or account changed | Clear the review and enrollment session. Reconnect, explicitly choose the credential and enroll that identity. Never silently substitute stake for payment. |
| Preparation missing | Verify and submit `accountPreparation(account)`, then check factory/key/configuration before funding/deployment. |
| AA21/prefund or insufficient balance | Check EntryPoint deposit, signed maximum operation cost, account native balance and the outer submitter's balance separately. |
| AA24/invalid signature or unsupported encoding | Recheck key/address/protected headers and exact signed payload. Do not fix a signature by changing its operation. |
| AA25/nonce changed | Query the exact previous operation hash and canonical receipt. Once resolved, prepare a newly reviewed operation at the current nonce. |
| AA26/verification gas or public admission failure | Use the documented stake/table profile and preparation/prefund procedure; compare provider limits and the current run diagnostics. Any signed gas change requires new wallet authorization. |
| RPC timeout, unknown broadcast result | Preserve the exact operation and transaction hashes. Poll ordinary RPC and the adapter before retrying the unchanged authorization. Do not reserve another nonce blindly. |
| Zero/mismatching Base receipt block hash | Keep observing until the receipt matches a mined block. The supplied canonical receipt helper does this before accepting effects. |
| `execution-reverted` | Inspect the EntryPoint event and revert reason. Nonce and gas may be consumed; calls did not succeed. Expected-policy-rejection evidence deliberately exercises this case. |
| Public/private endpoint unavailable | Switch a compatible account to another adapter after checking any pending authorization. Identity and policies remain unchanged; switching cannot cancel an already broadcast operation. |
| Sender lock already exists | Verify the owning process and its transaction journal. Resolve pending hashes first; remove a stale lock only after proving no sender still uses it. |

The reference app persists public authorization and inclusion evidence but keeps
sessions in memory. A production host implements durable sessions, operations,
authentication, TLS, quotas and application-specific funding. The reusable
challenge store provides memory and SQLite implementations; a distributed store
must atomically consume the matching challenge and recheck expiry. Back up
challenge/operation stores and submitter journals with appropriate access rules.
Public signatures reveal their signed payload and address: publish evidence
deliberately, and keep real application-user captures subject to the host's
retention policy.

## Wallet and account changes

Deterministic identity includes the Cardano public key, exact protected headers,
protocol/factory build inputs, initial policy, namespace and index.
Endpoint, bundler operator, token and submitter key are absent. A changed wallet
key, protected-header format, deployment input or policy can create a different
account. Preserve the original manifest and public identity record as durable inputs for the account.

General accounts have Cardano-root administration under Kernel's module model.
The supplied SDK demonstrates ordinary CALL, transfers and atomic batches; custom
admin operations need explicit review and correct Kernel authorization. The
permanent profiles have no administrator, owner opt-out, root replacement,
upgrade, extra validator, executor or delegatecall path. Their hook blocks these
paths, account self-targets and nested execution. EntryPoint is not on either
supplied allowlist. New restrictions or
recovery designs require a separately specified profile with its own authority
analysis. Do not advertise key rotation or recovery for these immutable restricted
profiles. Lost Cardano authority can leave their funds inaccessible.

An SDK/service upgrade does not upgrade an account contract. Compare creation
and runtime bytecode and repeat identity, authorization, policy and route tests
for any revised contract or factory. Asset movement remains subject to the
account key and its policy; an upgrade is not an authority bypass.

## Private service maintenance

Run one funded executor per coordinated worker deployment. Use the systemd
template with a dedicated OS user, loopback-only listeners and a same-host TLS
proxy exposing only the authenticated gateway. Protect secrets at mode 0600.
Monitor lifecycle, authenticated metrics, RPC health, executor balance, pending
operation age and canonical inclusion. The supplied queue is not durable; retain
hashes at the application and reconcile chain state after restart.

SIGHUP replaces validated admission/gas/rate settings. Network, worker build,
credentials and process settings require restart. Stop accepting work before
draining tracked operations, then SIGTERM the runner. It closes both ports and
reports unexpected worker failure as a nonzero process exit. Already broadcast
transactions may still mine. Admission changes cannot weaken onchain signature
or policy validation; the local execution tests exercise this boundary.

Review new dependency advisories against the exact lockfile and the
[dependency inventory](dependency-review.md). Upgrade a worker dependency or
upstream commit in an isolated checkout, update every source/archive/patch pin,
rebuild from source, run gateway/strict-decoder/local-service regressions, then
repeat bounded Sepolia checks with freshly reviewed wallet authorizations.
Keep GPL source/build inputs and notices with any distributed Alto binary/image.
The new cryptographic code requires its own review; upstream project audits do
not transfer automatically to these changes. Operational costs, responsibilities
and optional independent audit scope are in [handover](handover.md).
