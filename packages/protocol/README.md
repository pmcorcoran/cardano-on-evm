# @cardano-on-evm/protocol

Initial 0.1.0 MIT-licensed deterministic account identity, profile configuration,
canonical Kernel calls/batches, EntryPoint 0.7 operation packing, hashing and
Cardano authorization encoding. Transport and service credentials are separate
from identity.

Exports include `deriveProfileIdentity`, `profileConfigHash`,
`deriveTableIdentity`, `tableConfigHash`, `encodeTargetAllowlist`,
`encodeSelectorAllowlist`, `encodeCalls`, `decodeCalls`, restricted execution
wrapping/decoding, `packOperation`, `operationHash`, `operationPayload`,
`validatorSignature` and operation JSON conversion.

General, restricted and experimental-general derivation is always portable.
Changing only chain ID preserves salts, addresses and factory data when all
infrastructure and creation bytes match. Chain ID remains required and binds
enrollment and operation authorization. Profile enrollment uses
`cardano-kernel:identity:v1:profile:portable`; experimental enrollment uses
`cardano-kernel:identity:v1:experimental-general:portable`. The experimental
account salt uses its separate domain without a suffix or chain ID.

See the source release's `docs/identity.md`, `docs/policies.md` and
`docs/protocol.md` for the complete ordered encodings. Use verified current
contract artifacts and immutable infrastructure bindings. Arbitrary bytecode or
chain settings do not establish bundler compatibility. Node ESM, TypeScript
declarations and source are included.
