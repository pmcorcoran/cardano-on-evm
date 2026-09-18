# Architecture

The initial `0.1.0` implementation separates Cardano authority, deterministic
account configuration, and transaction delivery.

| Component | Responsibility |
| --- | --- |
| `packages/wallet` | Strict CIP-8/CBOR/address validation and explicit CIP-30 credential selection |
| `packages/enrollment` | Scoped expiring challenges, atomic memory/SQLite consumption, independent ABI/salt/CREATE2 derivation |
| `packages/protocol` | Portable profile identity, operation wire encoding and authorization domains |
| `packages/sdk` | Frozen account/operation snapshots, preparation intents, enrollment comparison and wallet signing |
| `packages/submission` | Public/private ERC-4337 and ordinary-RPC direct adapters with matching inner receipt validation |
| `packages/contracts` | Nine current contract artifacts, exact source/license closure and build manifest |
| `contracts/crypto` | Bounded SHA-512, Ed25519 verification and checked immutable curve precomputation |
| `contracts/profiles`, `contracts/policies` | General administration and immutable target/selector restrictions |
| `infra/bundler` | Separately installed Alto worker, authenticated admission gateway, patches and lifecycle management |
| `apps/reference`, `apps/wallet-lab`, `apps/live-lab` | Enrollment, explicit operation review and operator-selected capture workflows |

Enrollment checks the exact application, Cardano address/network, EVM chain,
configuration, expiry and canonical message before a wallet prompt. The backend
verifies the signature and credential, derives independently, and atomically
consumes the challenge while still unexpired. The returned identity is compared
field by field. Enrollment creates no spending authority for the server.

Both profile families use CREATE2 with chain-independent account salts. The
configuration hash still includes chain ID. Immutable validator/factory/policy
bytes, public key, exact protected headers, namespace and index determine
identity. Infrastructure address equality alone is insufficient: runtime bytes
and immutable bindings must also be checked. The two-chain test controls Kernel's
constructor chain context to make its cached EIP-712 runtime identical, then
restores each chain before enrollment and operation work.

The wallet signs the chain-bound EntryPoint v0.7 operation payload defined in
[protocol](protocol.md). The validator recomputes the actual hash and rejects
Kernel's replayable-hash shortcut. Signed calls, fees, nonce, sender, deployment
and sponsor fields cannot change during asynchronous prompts or submission.

Permissionless preparation checks the compressed key, coordinate and prime
subgroup, constructs a 256-entry table onchain, and deploys an immutable
validator. No server-supplied precomputation is trusted. Preparation/funding
payers receive no account key or administrative capability.

General and experimental-general accounts allow Cardano-root Kernel
administration. Restricted profiles install a fixed root and hook and reject
administration, self-calls, alternate execution modes, additional validators,
executors, root changes and upgrades. Every call in a canonical atomic batch
is checked before execution. See [policies](policies.md).

Alto is outside the six-package core dependency graph. Its gateway admission
rules can refuse an operation but cannot override onchain authorization. Strict
parser regressions use generated traces with the actual patched worker. Basic
local execution independently exercises real EntryPoint/Kernel/policy behavior.
Those two checks do not establish complete strict execution on the local tracer.
See [acceptance](acceptance.md) and [bundler limits](../infra/bundler/README.md).
