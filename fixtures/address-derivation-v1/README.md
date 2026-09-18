# Portable address known answers

These files contain generated public test data. The infrastructure addresses are
synthetic and do not assert deployed contracts or public-chain acceptance. The
generator derives public Ed25519 keys from deterministic test seeds and uses the
current compiled validator and profile-factory creation bytes.

`inputs.json` covers general, restricted targets, restricted selectors and
experimental-general accounts: 225 successful derivations and 20 rejected key
subgroup or protected-header inputs. Successful rows include key/header padding,
chain IDs, namespaces, uint256 indexes, infrastructure addresses, creation bytes,
policy addresses and hashes, policy bytes, rule counts and selector permissions.
Raw policy-byte boundary rows test ABI encoding; their payloads do not claim to
be accepted by a deployed policy.

`protocol-vectors.json` and `backend-vectors.json` were captured independently
through the protocol/SDK and enrollment-backend entrypoints. Each records the
complete identity, factory target and calldata, account preparation and validator
preparation. The backend uses its independent ABI, salt and CREATE2 calculation.

`provenance.json` identifies the source hashes at capture, the fixed input/vector
hashes, and all nine current contract ABI and creation/runtime byte hashes,
together with the compiler settings and input identity. These answers were frozen
before the API simplification; the capture source hashes therefore identify the
checkpoint, not the current edited TypeScript files.

Run the explicit comparison after building contracts:

```sh
node --conditions=development --import tsx scripts/export-address-fixtures.ts --check
```

The exporter refuses to overwrite existing answers. An explicit `--out` pointing
to an empty directory generates a separate set from current source for review.
Tests read the checked-in expectations without regenerating them.
