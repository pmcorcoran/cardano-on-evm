import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { hexToBytes, toHex, type Hex } from 'viem';
import { deriveProfileIdentity, deriveTableIdentity, type ProfileIdentityConfig, type TableIdentityConfig } from '../packages/protocol/src/index.js';
import { deriveBackendProfileIdentity, deriveBackendTableIdentity } from '../packages/enrollment/src/index.js';
import { accountFactory, accountFromVerifiedKey, accountPreparation, validatorPreparation } from '../packages/sdk/src/index.js';
import { parseCardanoAddress } from '../packages/wallet/src/index.js';
import { addressArtifactSet, bindAddressArtifacts, verifyAddressArtifactBinding } from '../scripts/lib/address-artifacts.js';
import { readProfileManifest, readTableIdentityManifest, profileConfigFromCapture } from '../scripts/lib/identity-manifest.js';
import { fixtureAddress } from './fixtures.js';

const root = 'fixtures/address-derivation-v1';
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const stringify = (v: unknown) => JSON.stringify(v, (_, value) => typeof value === 'bigint' ? value.toString() : value);
const lower = (v: unknown) => JSON.parse(stringify(v).toLowerCase());
const inputs = read(`${root}/inputs.json`), frozen = read(`${root}/protocol-vectors.json`), backendFrozen = read(`${root}/backend-vectors.json`);
const provenance = read(`${root}/provenance.json`);
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
type Config = TableIdentityConfig | ProfileIdentityConfig;
type InputCase = { id: string; variant: string; configId: string; publicKey: Hex; protectedHeaders: Hex; category: string; overrides?: Record<string, string | number> };
const configFor = (item: InputCase): Config => {
  const fields = { ...inputs.configs[item.configId], ...item.overrides };
  return { ...fields, index: BigInt(fields.index) };
};
const derive = (c: Config, key: Hex, headers: Hex) => 'profile' in c ? deriveProfileIdentity(key, headers, c) : deriveTableIdentity(key, headers, c);
const backend = (c: Config, key: Hex, headers: Hex) => 'profile' in c ? deriveBackendProfileIdentity(key, headers, c) : deriveBackendTableIdentity(key, headers, c);
const accountFor = (item: InputCase, config = configFor(item)) => {
  const key = new Uint8Array(hexToBytes(item.publicKey));
  return accountFromVerifiedKey({ publicKey: key, protectedHeaders: hexToBytes(item.protectedHeaders), signature: new Uint8Array(64), signStructure: new Uint8Array(), address: parseCardanoAddress(toHex(fixtureAddress(14, 0, key)), 0) }, config);
};

test('portable answers are frozen public test data with complete independent provenance and input coverage', () => {
  assert.equal(inputs.kind, 'generated-public-test-data');
  assert.equal(inputs.infrastructureDeploymentVerified, false);
  assert.equal(provenance.protocolBackendVectorsMatched, 225);
  assert.equal(provenance.subgroupAndHeaderRejections, 20);
  assert.equal(provenance.capturedBeforeApiSimplification, true);
  for (const [file, expected] of Object.entries(provenance.frozenFiles)) assert.equal(sha(`${root}/${file}`), expected, file);
  assert.equal(frozen.inputsSha256, sha(`${root}/inputs.json`));
  assert.equal(backendFrozen.inputsSha256, frozen.inputsSha256);
  assert.equal(inputs.cases.length, 225);
  assert.equal(new Set(inputs.cases.map((item: InputCase) => item.id)).size, 225);
  assert.deepEqual(lower(frozen.vectors), lower(backendFrozen.vectors));
  assert.deepEqual([...new Set(inputs.cases.map((item: InputCase) => item.variant))].sort(), ['experimental-general', 'general', 'selectors', 'targets']);
  assert.equal(inputs.cases.filter((item: InputCase) => item.category === 'key-header-padding').length, 128);
  assert.equal(inputs.cases.filter((item: InputCase) => item.category === 'encoding-boundary').length, 35);
  const headerLengths = new Set(inputs.cases.map((item: InputCase) => (item.protectedHeaders.length - 2) / 2));
  for (const length of [1, 23, 24, 31, 32, 33, 74, 128, 130, 255, 256]) assert.ok(headerLengths.has(length));
  for (const config of Object.values(inputs.configs) as object[]) assert.equal('addressDerivationMode' in config, false);
});

test('all complete identities and initialization, factory and preparation calls match both frozen entrypoints', () => {
  const records: unknown[] = [];
  const artifactIdentity = addressArtifactSet().identity;
  for (const [index, item] of (inputs.cases as InputCase[]).entries()) {
    const config = configFor(item);
    const sdk = derive(config, item.publicKey, item.protectedHeaders);
    const independent = backend(config, item.publicKey, item.protectedHeaders);
    assert.deepEqual(lower(sdk), lower(independent), `${item.id}: independent identity`);
    assert.deepEqual(lower(sdk), lower(frozen.vectors[index].identity), `${item.id}: protocol checkpoint`);
    assert.deepEqual(lower(independent), lower(backendFrozen.vectors[index].identity), `${item.id}: independent checkpoint`);
    const account = accountFor(item, config);
    const actual = { id: item.id, variant: item.variant, identity: account.identity, factory: { to: accountFactory(account), data: account.identity.factoryData, value: '0' }, preparation: accountPreparation(account), validatorPreparation: validatorPreparation(account) };
    assert.deepEqual(lower(actual), lower(frozen.vectors[index]), `${item.id}: all factory targets and calldata`);
    assert.deepEqual(lower(actual), lower(backendFrozen.vectors[index]), `${item.id}: independent preparation and factory calls`);
    const changed = { ...config, chainId: config.chainId === 31338 ? 31337 : 31338 };
    const other = derive(changed, item.publicKey, item.protectedHeaders);
    assert.deepEqual(lower(other), lower(backend(changed, item.publicKey, item.protectedHeaders)));
    assert.notEqual(sdk.configHash, other.configHash, `${item.id}: chain-bound enrollment`);
    assert.deepEqual({ ...sdk, configHash: other.configHash }, other, `${item.id}: every address input is chain independent`);
    records.push({ id: item.id, profile: account.profile, policyVariant: item.variant, baseContractBuildSha256: artifactIdentity.contractsSha256,
      infrastructureDeploymentVerified: false, encodingBoundaryOverrides: item.overrides ?? {}, chainId: config.chainId, otherChainId: changed.chainId,
      sdk, independentBackend: independent, factory: actual.factory, otherChain: other, frozenPortableMatched: true, chainBoundEnrollment: true });
  }
  assert.equal(records.length, 225);
  const path = process.env.ADDRESS_DIFFERENTIAL_EVIDENCE_FILE;
  if (path) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, stringify({ kind: 'independent-address-derivation-matrix', fixture: 'generated-public-test-data', allChecksPassed: true, rows: records }) + '\n'); }
});

test('both independent derivations reject every frozen subgroup and malformed-header input', () => {
  for (const item of inputs.invalidCases as InputCase[]) {
    const config = configFor(item);
    const reason = item.category === 'key-subgroup-rejection' ? /subgroup/i : /header|identity input/i;
    assert.throws(() => derive(config, item.publicKey, item.protectedHeaders), reason, item.id);
    assert.throws(() => backend(config, item.publicKey, item.protectedHeaders), reason, item.id);
    assert.throws(() => accountFor(item, config), reason, item.id);
  }
});

test('current profile manifests require explicit artifact bindings, chain consistency and independent identities', () => {
  const selected = addressArtifactSet();
  const profiles = Object.fromEntries(['general', 'targets', 'selectors'].map((id) => {
    const item = (inputs.cases as InputCase[]).find((entry) => entry.id === id)!;
    const config = configFor(item) as ProfileIdentityConfig;
    return [id, { config, artifactBinding: bindAddressArtifacts(config), identity: derive(config, item.publicKey, item.protectedHeaders), backendIdentity: backend(config, item.publicKey, item.protectedHeaders) }];
  }));
  const manifest = { addressDerivationMode: 'portable', artifactIdentity: selected.identity, chainId: 31337, profiles };
  const general = profiles.general!;
  const config = general.config;
  assert.deepEqual(profileConfigFromCapture(config), config);
  const current = bindAddressArtifacts(config);
  assert.throws(() => bindAddressArtifacts({ ...config, validatorCreationCode: '0x6000' }), /Validator creation bytes/);
  assert.throws(() => bindAddressArtifacts({ ...config, profileFactoryCreationCode: '0x6000' }), /Profile factory creation bytes/);
  assert.throws(() => verifyAddressArtifactBinding(config, { ...current, addressDerivationMode: undefined } as any), /metadata must describe portable/);
  assert.throws(() => verifyAddressArtifactBinding(config, { ...current, addressDerivationMode: 'unsupported' } as any), /metadata must describe portable/);
  assert.throws(() => verifyAddressArtifactBinding(config, { ...current, artifactIdentity: { ...current.artifactIdentity, contractsSha256: '00'.repeat(32) } }), /artifact identity/);
  assert.throws(() => verifyAddressArtifactBinding({ ...config, profilePreparationFactory: toHex(0x5501, { size: 20 }) }, current), /factory addresses/);
  assert.throws(() => verifyAddressArtifactBinding({ ...config, tableFactory: toHex(0x5502, { size: 20 }) }, current), /factory addresses/);
  const temp = mkdtempSync(join(tmpdir(), 'profile-identity-manifest-test-'));
  try {
    const file = join(temp, 'manifest.json'), save = (value: unknown) => writeFileSync(file, stringify(value));
    save(manifest);
    assert.equal(readProfileManifest(file).addressDerivationMode, 'portable');
    assert.deepEqual(readProfileManifest(file).profiles.general!.config, config);
    for (const field of ['contractsSha256', 'buildSha256']) {
      save({ ...manifest, artifactIdentity: { ...selected.identity, [field]: '00'.repeat(32) } });
      assert.throws(() => readProfileManifest(file), /Manifest artifact identity/);
    }
    for (const marker of [undefined, 'unsupported']) {
      save({ ...manifest, addressDerivationMode: marker }); assert.throws(() => readProfileManifest(file), /Manifest must describe portable/);
    }
    save({ ...manifest, artifactIdentity: null }); assert.throws(() => readProfileManifest(file), /Manifest artifact identity/);
    save({ ...manifest, chainId: 31338 }); assert.throws(() => readProfileManifest(file), /chain/i);
    save({ ...manifest, profiles: { general: { ...general, config: { ...config, addressDerivationMode: 'portable' } } } }); assert.throws(() => readProfileManifest(file), /Unsupported configuration field/);
    save({ ...manifest, profiles: { general: { ...general, identity: { ...general.identity, account: toHex(0x5503, { size: 20 }) } } } }); assert.throws(() => readProfileManifest(file), /identity/i);
    save({ ...manifest, profiles: { general: { ...general, backendIdentity: { ...general.backendIdentity, configHash: toHex(0n, { size: 32 }) } } } }); assert.throws(() => readProfileManifest(file), /identity|backend/i);
    save({ ...manifest, profiles: { general: { ...general, backendIdentity: undefined } } }); assert.throws(() => readProfileManifest(file), /identity/i);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('current experimental identity manifests require explicit chain, metadata and matching complete identities', () => {
  const item = (inputs.cases as InputCase[]).find((entry) => entry.id === 'experimental-general')!;
  const config = configFor(item) as TableIdentityConfig;
  const record = { addressDerivationMode: 'portable', chainId: config.chainId, config, identity: derive(config, item.publicKey, item.protectedHeaders), backend: backend(config, item.publicKey, item.protectedHeaders), artifactBinding: bindAddressArtifacts(config) };
  const temp = mkdtempSync(join(tmpdir(), 'table-identity-manifest-test-'));
  try {
    const file = join(temp, 'identity.json'), save = (value: unknown) => writeFileSync(file, stringify(value));
    save(record); assert.deepEqual(readTableIdentityManifest(file).config, config);
    for (const marker of [undefined, 'unsupported']) { save({ ...record, addressDerivationMode: marker }); assert.throws(() => readTableIdentityManifest(file), /must describe portable/); }
    save({ ...record, chainId: 31338 }); assert.throws(() => readTableIdentityManifest(file), /chain/i);
    save({ ...record, config: { ...config, kernelFactory: toHex(0x6601, { size: 20 }) } }); assert.throws(() => readTableIdentityManifest(file), /factory addresses/);
    save({ ...record, identity: { ...record.identity, initializeData: '0x' } }); assert.throws(() => readTableIdentityManifest(file), /identity/i);
    save({ ...record, backend: { ...record.backend, accountSalt: toHex(0n, { size: 32 }) } }); assert.throws(() => readTableIdentityManifest(file), /identity|derivation/i);
    save({ ...record, config: { ...config, addressDerivationMode: 'portable' } }); assert.throws(() => readTableIdentityManifest(file), /Unsupported configuration field/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
