# @cardano-on-evm/contracts

Initial 0.1.0 ABI, creation/runtime artifacts and corresponding Solidity source
for Cardano-controlled Kernel accounts. The package contains exactly these named
ESM exports plus `manifest`:

- `PreparedTableValidator`, `PreparedTableFactory`.
- `ProfileAccountFactory`, `ProfilePreparationFactory`.
- `RestrictedExecutionHook`, `TargetAllowlistPolicy`, `SelectorAllowlistPolicy`.
- Pinned Kernel 0.3.3 `Kernel` and `KernelFactory`.

Each contract includes `abi`, `bytecode`, `deployedBytecode` and
`immutableReferences`. The manifest identifies compiler/settings, compiler inputs,
required source/license files and each artifact's SHA-256 identity. Its fixed
`addressDerivationMode: 'portable'` marker describes the current build. Callers
use the ordinary named artifacts and current `manifest` directly.

```ts
import { PreparedTableValidator, ProfileAccountFactory, manifest }
  from '@cardano-on-evm/contracts';
const validatorCreationCode = PreparedTableValidator.bytecode;
const profileFactoryCreationCode = ProfileAccountFactory.bytecode;
```

Build with `npm run build:contracts` from the source release. Packaging recreates
its owned output directories and includes the selected contracts' transitive
imports under their original source paths, required upstream licenses and pinned
source metadata. Project contracts are MIT; upstream notices retain their own
licenses. See `THIRD_PARTY_NOTICES.md` and the corresponding source release for
the complete compiler and upstream inventory.

Runtime templates include immutable slots. Verify configured immutable values
and every other runtime byte against the actual infrastructure before preparing
or submitting an account. Matching infrastructure addresses, creation bytes,
keys, exact headers and configuration are prerequisites for portable predictions.
The implementation is unaudited; the source release's identity, policy and
security documents define its supported configuration and limitations.
