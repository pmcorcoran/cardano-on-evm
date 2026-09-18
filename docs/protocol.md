# Protocol and authorization, version 1

The supported path uses Kernel 0.3.3 and EntryPoint 0.7 on Base Sepolia (84532).
The contracts use Solidity 0.8.30. The complete pins, build settings and configured upstream
addresses are in [versions.json](../versions.json). New original code is version
0.1.0. This version has internal tests and review; it has no independent audit.

The `cardano-kernel:` prefixes are fixed protocol identifiers, independent of
the Cardano on EVM project and package names. Preserve their exact bytes in
authorization domains, address derivation, and deterministic test inputs.

## Enrollment message

The signed payload is UTF-8 JSON without whitespace, in precisely this property
order: `domain`, `challenge`, `application`, `cardanoAddress`, `cardanoNetwork`,
`baseChainId`, `configHash`, `issuedAt`, `expiresAt`. The domain is
`cardano-kernel:enrollment:v1`. The challenge is 32 unpredictable bytes encoded
as 64 lowercase hex characters. The application is an exact HTTP(S) origin.
The Cardano address is lowercase raw-address hex without `0x`; times are Unix
milliseconds, safe integer JSON numbers. The configuration commitment is a
lowercase `0x`-prefixed bytes32. The default lifetime is five minutes; the maximum
supported lifetime is fifteen minutes.

The backend selects the application, chain, Cardano network and configuration.
The SDK recomputes and checks that complete scope before asking Lace to sign.
It verifies the returned signature/address locally and independently derives the
account. The backend verifies the same proof and only returns success after its
store atomically consumes the exact challenge payload while still unexpired.
See [backend and SDK APIs](sdk.md). Application authentication/session issuance
is separate from onchain account authority.

## Cardano encoding and address binding

The wallet uses CIP-30 `signData(addressHex, payloadHex)` and returns a CIP-8
COSE_Sign1 and COSE_Key. The supported subset is specified in
[compatibility](compatibility.md). The key must be a canonical, nonzero,
prime-subgroup Ed25519 point. BLAKE2b-224 of its exact compressed 32-byte encoding
must equal the selected key credential in the claimed address.

Payment and stake credentials are explicitly selected identities. Reward type
14 selects the stake profile; there is no automatic fallback. Script
credentials and unsupported address encodings reject. The network nibble must
match the configured Cardano network. Network 0 denotes the testnet class and
does not distinguish preview from preprod.

Protected COSE headers retain their exact verified byte encoding, including the
address and optional matching `kid`. They are committed into account identity.
The signed structure is canonical CBOR:

```
["Signature1", protectedHeadersBytes, bytes(""), payloadBytes]
```

The implementation rejects hashed or detached payloads, nonminimal/indefinite
CBOR, duplicate/unknown map keys, mismatched key IDs and unsupported algorithms.
Byte, depth and collection bounds apply before cryptographic verification.

## Operation message

`U` is EntryPoint 0.7's packed UserOperation. All integer fields use Solidity ABI
uint256 words; the two paired gas fields are uint128 halves of bytes32 values.
The protocol package uses the pinned viem v0.7 packing/hash implementation; the
validator independently performs these hashes onchain:

```
inner = keccak256(abi.encode(
  U.sender, U.nonce, keccak256(U.initCode), keccak256(U.callData),
  U.accountGasLimits, U.preVerificationGas, U.gasFees,
  keccak256(U.paymasterAndData)
))
userOpHash = keccak256(abi.encode(inner, entryPoint, uint256(chainId)))
domain = keccak256(UTF8("cardano-kernel:operation:v1"))
payload = keccak256(abi.encode(domain, userOpHash))
```

Lace signs the resulting **32 raw payload bytes** through the same CIP-8 path.
The operation signature delivered to Kernel is exactly
`abi.encode(bytes protectedHeaders, bytes32 R, bytes32 S)`. `R` and `S` preserve
the wallet's raw Ed25519 signature bytes; `S` is interpreted little-endian by
the verifier. Trailing bytes and noncanonical ABI reject. The supplied headers
must match the validator's immutable commitment. The validator reconstructs
the COSE signing structure for the 32-byte payload and verifies Ed25519 onchain.

The validator recomputes the current-chain, immutable-EntryPoint hash and compares
it with Kernel's supplied hash. This rejects Kernel's replayable-hash shortcut.
Sender, nonce, deployment inputs, calls, value, gas limits, fees and paymaster
fields are authorized. Any change requires a new wallet signature. A bundler
URL, operator, submission route and transaction submitter are absent from the
authorization and identity. A valid saved operation can be delivered by any
compatible adapter, once, subject to EntryPoint nonce rules.

Enrollment JSON is a separate domain and cannot authorize an operation. The
validator does not accept a backend attestation or an Ethereum submitter key.
ERC-1271 message validation returns failure in this release; support is not
implied by successful UserOperation validation.

## Identity and execution

[Final profile derivation and authority](policies.md) specifies all constructor,
CREATE2, namespace, index, initial-policy and administrative inputs. The
[experimental-general table identity](identity.md) has its own account salt domain.
SDK and backend encoders are independent and agree with onchain predictions.

Single calls encode `target[20] || value[32] || calldata` inside canonical Kernel
`execute(bytes32,bytes)`. Batches contain 1–64 ABI-encoded call tuples and use
the batch mode byte. The public SDK exposes ordinary CALL with revert-on-failure
semantics. Restricted operations add Kernel's `executeUserOp` selector prefix,
which activates the immutable root execution hook. The hook checks every call
and rejects alternate modes, self-calls and administrative bypasses. General
root administration is deliberately available through Kernel's lower-level API.

Permissionless preparation verifies the key/subgroup and constructs an immutable
256-point table before deployment. No supplied table is trusted. This separate
transaction must be budgeted before account deployment. Local full-path tests
exercise the 500000 verification-gas limit with generated 74-byte reward headers
and EntryPoint prefunding. See [validation scope](acceptance.md).
