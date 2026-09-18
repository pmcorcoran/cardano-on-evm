# Initial 0.1.0 release

The initial release provides portable account derivation for general, permanently
restricted target/selector, and experimental-general profiles. Chain ID is
required and binds enrollment and operation authorization. Matching address
inputs predict the same account across chains.

The SDK snapshots account configurations as the read-only
`ResolvedAccountConfig`, independently compares backend enrollment predictions,
and verifies the wallet's returned CIP-8 authorization. Runtime configuration
validation rejects unsupported derivation fields before signing. The contracts
package exports nine current artifacts and one current manifest, with compiler,
source and artifact hashes. Fixed `portable` metadata describes this build;
account configuration does not select an artifact set.

Profile salts use the ABI encoding `(bytes32 ACCOUNT_DOMAIN, bytes32 namespace,
uint256 index)`. Experimental-general salts use their separate unsuffixed domain
and omit chain ID. Enrollment hashes retain the complete configuration and chain
ID with the domains `cardano-kernel:identity:v1:profile:portable` and
`cardano-kernel:identity:v1:experimental-general:portable`.

Validation uses generated public test inputs, frozen independent protocol/backend
known answers, real local deployments on two chains, replay rejection controls,
all-profile enrollment/signing and isolated consumption of six 0.1.0 tarballs.
The full-core harness builds from files selected by ordinary Git ignore/add
rules. Bundler parser regressions use generated simulation inputs separately from
real local execution checks. Current run reports record which gates ran and
passed; fixture generation alone is not execution or public-network evidence.

Package and archive checks require the exact current export/artifact allowlists,
verify source and bytecode hashes, reject workspace links and Alto dependencies,
and test a downloaded bundle without project deployment files. Source inventories
identify the actual worktree; versions remain coordinated at 0.1.0.

See [derivation and reproduction](address-derivation.md), [SDK integration](sdk.md)
and [policy limitations](policies.md). The contracts are unaudited. Permanently
restricted accounts have no administrator, policy replacement, key rotation or
upgrade escape. No publication, tag or public-network transaction is performed
by local validation.
