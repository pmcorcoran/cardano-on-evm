# Experimental-general table-account identity, version 1

This profile uses PreparedTableValidator with a general Cardano root, Kernel
0.3.3 and EntryPoint 0.7. It installs no policy, hook or application administrator.
General and permanently restricted profiles use the separate profile factory
specified in [profiles and policies](policies.md).

`deriveTableIdentity` in `packages/protocol/src/identity.ts` and
`deriveBackendTableIdentity` in `packages/enrollment/src/identity.ts` implement
these formulas separately. The backend has its own byte/ABI/CREATE2 encoding and
noble Keccak, without runtime SDK or viem ABI imports. It independently recovers
Edwards x from compressed y. Both require a canonical prime-subgroup Ed25519 key.
Enrollment also verifies the signature and Cardano address binding.

## Inputs

| Input | Encoding and effect |
| --- | --- |
| Public key | Exact compressed 32-byte Ed25519 key; affects validator/account |
| Protected headers | Exact verified CIP-8 bytes, 1–256 bytes; affect validator/account |
| Chain ID | Positive safe integer; binds enrollment and operation authorization |
| EntryPoint | Nonzero address, bound to module and account configuration |
| Kernel implementation/factory | Nonzero addresses, with pinned versions/builds |
| Table factory | Nonzero address, verified runtime and immutable EntryPoint |
| Validator creation code | Fully linked compiler output; hash binds the build |
| Namespace | Application-chosen bytes32, stable across enrollment sessions |
| Index | Application/user-chosen uint256, stable across enrollment sessions |

Challenge ID, expiry, browser session, submitter, sponsor and bundler endpoint
are absent from identity. Repeated enrollment with the same inputs is stable.
Payment and reward addresses normally identify different keys. Even where keys
match, changing exact signed headers changes the address. Wallet encoding changes
require explicit enrollment of the intended identity.

## Derivation

Hashes are Keccak-256. `abi.encode` is standard Solidity ABI, `||` concatenates
bytes, and `low20` takes the low 20 bytes of a hash.

```
tableDomain = keccak256(UTF8("cardano-kernel:prepared-table:v1"))
validatorSalt = keccak256(abi.encode(tableDomain, key, keccak256(headers)))
moduleInit = validatorCreationCode || abi.encode(entryPoint, key, edwardsX, headers)
validator = low20(keccak256(0xff || tableFactory || validatorSalt || keccak256(moduleInit)))

configDomain = keccak256(UTF8("cardano-kernel:identity:v1:experimental-general:portable"))
configHash = keccak256(abi.encode(
  configDomain, uint256(chainId), entryPoint, kernelImplementation,
  kernelFactory, tableFactory, keccak256(validatorCreationCode), namespace, index
))
accountDomain = keccak256(UTF8("cardano-kernel:identity:v1:experimental-general"))
accountSalt = keccak256(abi.encode(
  accountDomain, entryPoint, kernelImplementation,
  kernelFactory, tableFactory, keccak256(validatorCreationCode), namespace, index
))
initializeData = Kernel.initialize(
  bytes21(0x01 || validator), address(0), bytes(""), bytes(""), bytes[](0)
)
actualAccountSalt = keccak256(initializeData || accountSalt)
account = low20(keccak256(
  0xff || kernelFactory || actualAccountSalt || keccak256(proxyInitCode)
))
factoryData = KernelFactory.createAccount(initializeData, accountSalt)
```

The account salt excludes chain ID and uses an unsuffixed domain. The separate
enrollment hash includes chain ID and uses the complete `:portable` domain.
Addresses are ABI `address`; hashes and namespace are `bytes32`; Edwards x and
index are `uint256`; protected headers are `bytes`. Each field uses standard ABI
encoding in the shown order.

`proxyInitCode` is the exact 95-byte ERC-1967 creation code from pinned Solady
`LibClone.initCodeERC1967(implementation)`. Both implementations include its
explicit bytes. Its runtime is 61 bytes; implementation is in the ERC-1967 slot.
Solady's MIT license applies.

`configHash` scopes enrollment before the wallet reveals its key/header. The
account also binds the key/header through validator initialization. Kernel maps
the zero hook input to its installed-without-hook sentinel, address 1. Receipt
checks require that sentinel and initial validation nonce 1.

## Verification and limits

`tests/identity.test.ts` checks key/header lengths, ABI padding boundaries,
input mutations and chain separation. `tests/address-derivation.test.ts` verifies
frozen generated inputs against separately captured protocol/backend vectors,
including full initialization and factory calldata. The two-chain regression
requires actual deployments and operation replay rejection with positive controls.
[Address validation](address-derivation.md) describes its runtime prerequisites
and report format.

Applications must validate factory runtime hashes and immutable bindings. A
caller-supplied factory with unrelated code is not a safe account factory.
Changing an endpoint or operator does not change a derivation input. Experimental
general authority has no permanent policy restriction; the Cardano root controls
normal Kernel administration. The implementation is unaudited.
