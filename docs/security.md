# Security model and validation limits

The new cryptographic code and complete account integration have no independent
audit. Upstream audit claims do not transfer to this implementation. Review the
exact compiler, source and artifact inventory before choosing an operating scope.

## Trust boundaries

The Cardano wallet holds the spending key and asks for consent. A compromised
wallet/browser can misrepresent a payload; the application must show account,
chain, calls, value, permanent restrictions and signed fees. Enrollment servers
can choose configuration or refuse service, but cannot replace the verified
address key or gain onchain authority. Submitters, bundlers and sponsors can
withhold, reorder or pay for operations, but cannot authorize another operation.

General accounts permit Cardano-root Kernel administration. Restricted accounts
have a fixed Cardano root, immutable policy and no application administrator or
owner opt-out. Policy authors must consider mutable downstream contracts even
when a policy's own code hash is fixed. Funding grants no administrative role.

## Required security properties

| Boundary | Enforcement and regression |
| --- | --- |
| Address/key binding | Exact BLAKE2b-224 credential match; explicit payment/stake and network checks |
| Consent races | Atomic conditional memory/SQLite consumption with expiry rechecked after async derivation |
| Enrollment scope | Exact application, address, chain, config, time and canonical challenge bytes before signer invocation |
| Configuration | Unsupported fields and invalid chain/configuration reject before signing; resolved snapshots remain frozen |
| Signing/submission races | Account and operation snapshots across async wallet/adapter callbacks; mutation cannot change signed intent |
| Curve input | Canonical key/coordinate/parity/range checks and nonzero prime subgroup verification; no trusted external table |
| Encoding | Bounded canonical CBOR/ABI; unknown/duplicate keys, detached/hashed payloads, wrong key ID and trailing data reject |
| Replay | Validator recomputes actual current-chain EntryPoint hash; same-address operations fail across chains with nonce and authorization prerequisites controlled |
| Restricted authority | Canonical factory/root/hook; no admin/root/module/executor/upgrade/delegatecall/self-call/reentry bypass; batch calls checked before execution |
| Policy replacement | Creation commits policy code/configuration; execution checks the code hash; admission changes cannot override the hook |
| Artifact/manifests | Current explicit build marker, creation/runtime/compiler/linking identity, recorded factory bindings and independent derivation comparison |
| Broadcast ambiguity | Save stable transaction/operation hash before sending; resolve canonical receipt before retrying |
| Receipts | Match mined block, inner operation hash/sender/nonce and result rather than assuming outer transaction success |
| Gateway | Authenticated bounded admission; loopback worker, sanitized environment and logs, fixed outbound headers |
| Build completeness | Pinned vendor/lock/compiler inputs and ordinary Git add/export with exact source hashes and executable bits |

The cryptographic corpus retains independently sourced Wycheproof vectors and
provenance. Local checks compare SHA-512 to OpenSSL/noble at padding boundaries,
verify curve-table entries independently, test subgroup/coordinate failures,
and execute valid and mutated Ed25519 signatures through the actual EVM path.
Generated wallet cases cover payment/stake, optional key ID, valid unhashed
payloads and hashed/malformed rejection. See [acceptance](acceptance.md) for the
actual source-bound reports and [fixture provenance](../fixtures/wycheproof-provenance.json).

## Limits and operational responsibilities

Full strict Anvil execution is not established by generated parser tests. The
bundler harness separately runs the actual strict parser/gateway and real basic
local execution. Basic mode retains EntryPoint signature simulation and onchain
validation but lacks strict ERC-7562 opcode/storage admission. The default
operator template remains strict; any deviation must be explicit.

The isolated Alto runtime dependency tree requires continuing advisory review.
Source/patch pins and boundary checks do not mean the tree is vulnerability-free.
See [dependency review](dependency-review.md). Keep the executor budget separate
from account balances; host compromise can expose executor credentials.

The loopback reference app requires a current manifest and retains bounded,
in-memory sessions. Production integrations supply authentication, TLS, durable
sessions/operation records, monitoring, backups and funding policy. Generated
reference data cannot enable transaction submission. Real-wallet/provider/mainnet
acceptance requires separate runs; no local test result implies those outcomes.

Losing the Cardano key can make a restricted account inaccessible. Recovery,
rotation, cumulative spending limits and hosted sponsorship are not implemented
by extension interfaces alone. General administration is available only through
correct Cardano authorization. Optional audit scope and handover responsibilities
are in [handover](handover.md).
