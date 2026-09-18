# Account profiles, restrictions and authority

General and restricted profiles use a prepared Cardano validator and pinned
Kernel account. Restricted accounts support target and selector allowlists.
Experimental-general is a separate unrestricted table-account profile described
in [identity.md](identity.md).

`npm run experiment:policies` exercises the SDK/backend/EntryPoint/Kernel path
locally with general, target and selector configurations, calls, native transfers,
batches and prohibited operations. The two-chain regression additionally covers
all four profile/policy variants and chain-bound authorization. Current run
reports provide execution results; generated inputs are not public-chain evidence.

## Fixed creation configuration

`ProfilePreparationFactory` is permissionless and has no administrator. Its
immutable inputs are the Kernel implementation and checked table factory.
Preparation verifies their EntryPoint bindings and prepares the exact checked
Cardano key. It deterministically creates one `ProfileAccountFactory` for the
key, exact signed headers and policy configuration. Anybody may pay for this
step; no spending authority is granted to its caller.

The profile factory fixes the Cardano validator and root hook in its constructor.
`createAccount(namespace,index)` creates a Kernel ERC-1967 clone with exactly
those values and **an empty initialization-command list**. No caller can supply
another root, hook, initializer, module or implementation at the same address.
Account creation performs one CREATE2 and does not deploy cryptographic tables,
policies or hooks inside UserOperation validation.

For general accounts, policy, configuration and policy-code hash must all be
empty/zero. There is no hook. The Cardano root may authorize arbitrary normal
Kernel CALLs, native transfers and batches, and may administer or upgrade its
account. The SDK provides canonical CALL and atomic-batch construction. Kernel
has additional execution capabilities; general account applications enabling
them must explicitly construct and explain those operations.

For restricted accounts, a nonzero policy and its expected runtime-code hash
are creation inputs. Preparation rejects a different code hash. The factory
creates `RestrictedExecutionHook`, with fixed policy code and configuration.
There is **no application administrator, user opt-out, policy replacement,
recovery, key rotation or upgrade path** for this profile. A different policy
requires a different account. Funds can move only through calls permitted by
the existing policy; a policy that allows no exit can permanently prevent an
asset from moving. Applications must make that creation choice visible.

## Why the root cannot remove the restriction

This reasoning is specific to pinned Kernel 0.3.3 and the prepared Cardano module;
it is not a claim about every ERC-7579 hook or arbitrary Kernel initialization.

| Path | Enforcement |
| --- | --- |
| Root UserOperation | Kernel requires the `executeUserOp` selector prefix whenever its root has a hook. The hook then accepts only `execute(bytes32,bytes)` and canonical single/batch CALL modes. |
| Ordinary RPC / any bundler | All routes reach the same EntryPoint validation and Kernel hook; the hook runs before target execution. |
| Root/module/hook changes, upgrades, permissions, nonce administration | Direct administrative calldata lacks the required hook prefix; prefixed administration is rejected by the hook's execute-only check. |
| CALL to the account itself | Unconditionally rejected, including within a batch, even if a custom policy returns true. Zero-address calls are also rejected. |
| Batch | Canonical ABI is re-encoded and compared. Every target is checked before the first call; a forbidden later entry cannot leave earlier effects. Maximum 64 calls. |
| Delegatecall, try mode, staticcall, mode extensions | All rejected; only exact zero mode and `0x01` followed by 31 zero bytes are enabled. |
| Executor/fallback | None installed by the factory; installation is blocked. Tests call these entry points directly and through an allowed reentrant contract. |
| Calls from an allowed target or transaction submitter | Kernel requires its EntryPoint, itself or a root that also implements a hook. The Cardano validator is only a validator, so an external target cannot acquire that authority. |
| Enable mode / ERC-1271 | The Cardano root returns invalid for `isValidSignatureWithSender`; it cannot authorize enable-mode installation or offchain token-permit signatures. |
| 7702 | These are ERC-1967 clones with a fixed Cardano root. Kernel resolves root nonce mode to that module; a submitter's Ethereum signature does not become the account key. |
| Direct calls to hook install/uninstall | Configuration has no mutator. Kernel also catches module-uninstall reverts, so **the security argument does not rely on `onUninstall` reverting**; the hook must prevent reaching account uninstallation. |
| Reinitialization | Kernel rejects repeated initialization. The profile factory never accepts custom initialization data. |

The hook is an execution policy. A correctly signed but prohibited operation
can consume its nonce and gas while its call is reverted. Receipts report
`execution-reverted`, even when the outer EntryPoint transaction succeeds.
Bundler admission may reject such operations earlier; that does not establish or
weaken the onchain restriction. Invalid Cardano signatures fail validation.

## Supplied policies and extension interface

`TargetAllowlistPolicy` takes a sorted, unique `address[]` (1–64 entries) and
allows any CALL, including value, to those addresses. `SelectorAllowlistPolicy`
takes sorted, unique target rules, each with sorted unique bytes4 selectors and
explicit `allowEmpty` and `allowValue` flags. Empty calldata is a separate
permission from selector zero; 1–3-byte calldata is rejected. SDK helpers
`encodeTargetAllowlist` and `encodeSelectorAllowlist` construct the canonical
configuration. The hook limits total configuration to 16,384 bytes.

To add a policy, implement `ICallPolicy.validateConfig(bytes)` and
`checkCall(account,target,value,data,config)`. The check uses STATICCALL, cannot
modify account state and must return true for each allowed call. Deploy reviewed
stateless code, pin its runtime hash and pass its immutable configuration at
profile preparation. The hook still enforces all structural restrictions.
An application must review downstream dependencies too: a code-hash check cannot
detect policy changes implemented through mutable storage, proxies or external
administrators. The two supplied policies use none of these mechanisms.

Allowlisting a contract/function is not a spending or recipient limit. For
example, allowing ERC-20 `approve` can grant another contract an allowance, and
allowing a router can permit its downstream actions. Those effects are part of
the explicitly selected policy and require appropriate parameter checks.

Optional extensions are separate from mandatory target/selector support:

- **Recipients:** a stateless policy can decode ERC-20 transfer parameters and
  require specific recipients; native recipients are already target addresses.
- **Per-call amounts:** a stateless policy can cap native value or decoded token
  amounts. This does not cap cumulative spending or allowances.
- **Cumulative limits:** require a stateful hook/policy interface with atomic
  reservation, reentrancy handling and defined revert/batch accounting. The
  current STATICCALL policy interface intentionally cannot maintain a counter.
- **Time windows:** an execution policy can compare block timestamp; unlike
  signature validation, the execution phase permits this environmental read.
  This policy is not implemented, and must account for expiry between signing,
  admission and inclusion.

## Deterministic profile identity

Both `deriveProfileIdentity` and independent
`deriveBackendProfileIdentity` specify the same bytes through separate production
implementations. Frozen known answers and local deployment tests compare their
complete outputs. `profileConfigHash`
scopes enrollment to profile kind, chain, EntryPoint, implementation, table and
preparation factories, validator/profile-factory creation-code hashes, policy,
policy runtime hash, exact configuration, namespace and account index.

```
profileFactoryInit = ProfileAccountFactory.creationCode || abi.encode(
  implementation, tableFactory, key, edwardsX, headers,
  policy, policyConfig, policyCodeHash
)
profileFactory = CREATE2(profilePreparationFactory,
  keccak256("cardano-kernel:profile-preparation:v1"), profileFactoryInit)
hook = general ? address(0) : CREATE(profileFactory, nonce=1)
initializeData = Kernel.initialize(0x01 || validator, hook, "", "", [])
salt = keccak256(abi.encode(
  keccak256("cardano-kernel:profile-account:v1"), namespace, index
))
account = CREATE2(profileFactory, keccak256(initializeData || salt),
  Solady.ERC1967ProxyInitCode(implementation))
```

The validator derivation is the checked-table derivation in
[`identity.md`](identity.md). Changing key, exact headers, implementation,
factories, creation bytes, policy/code/config, namespace or index changes the
appropriate preparation/account address. The portable salt above uses exactly
`(bytes32,bytes32,uint256)` ABI encoding and `accountSalt(bytes32,uint256)` is
`pure`. Chain ID is absent from this salt and remains required for enrollment
and operation authorization.

Enrollment `profileConfigHash` always retains chain ID. Its ABI fields remain:
`bytes32 identityDomain`, `uint256 profileId`, `uint256 chainId`, four addresses
(`entryPoint`, `kernelImplementation`, `tableFactory`, `profilePreparationFactory`),
validator and profile-factory creation-code hashes, policy address, policy-code
hash, policy-configuration hash, namespace, index. Hashes and namespace are
`bytes32`; index is `uint256`. Profile ID is 0 for general and 1 for restricted.
The domain string is exactly `cardano-kernel:identity:v1:profile:portable`,
hashed before ABI encoding. This configuration commitment is separate from the
account salt and binds enrollment to the selected chain and configuration.

Matching infrastructure addresses and creation bytecode are prerequisites for
portable addresses. See [artifact and manifest verification](address-derivation.md).
EntryPoint and code versions must agree with the actual immutable deployment
bindings: changing a manifest claim without changing that infrastructure is an
invalid configuration, not a supported alternate deployment. A backend, RPC URL,
bundler operator, submitter or sponsor is never an identity input.
