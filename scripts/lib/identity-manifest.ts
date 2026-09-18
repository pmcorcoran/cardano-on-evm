import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveProfileIdentity, deriveTableIdentity, type ProfileIdentityConfig } from '../../packages/protocol/src/index.js';
import { bindAddressArtifacts, verifyAddressArtifactBinding } from './address-artifacts.js';

const normalize = (value: unknown): unknown => {
  if (typeof value === 'string') return value.startsWith('0x') ? value.toLowerCase() : value;
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  return value;
};
function readManifest(path: string): any {
  assert.ok(typeof path === 'string' && path.length, 'An explicit manifest path is required');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'Invalid identity manifest');
  assert.equal(manifest.addressDerivationMode, 'portable', 'Manifest must describe portable derivation');
  assert.ok(Number.isSafeInteger(manifest.chainId) && manifest.chainId > 0, 'Manifest chain is invalid');
  return manifest;
}

/** Read a current profile manifest with explicit artifact and factory bindings. */
export function readProfileManifest(path: string): any {
  const manifest = readManifest(path);
  assert.ok(manifest.profiles && typeof manifest.profiles === 'object' && !Array.isArray(manifest.profiles) && Object.keys(manifest.profiles).length, 'Profile manifest is empty');
  const profiles = Object.fromEntries(Object.entries(manifest.profiles).map(([name, item]: [string, any]) => {
    assert.ok(item && typeof item === 'object' && item.config, 'Profile configuration missing');
    const config = profileConfigFromCapture(item.config);
    assert.equal(config.chainId, manifest.chainId, 'Manifest/config chains differ');
    verifyAddressArtifactBinding(config, item.artifactBinding);
    assert.deepEqual(manifest.artifactIdentity, item.artifactBinding.artifactIdentity, 'Manifest artifact identity differs from current factory artifacts');
    if (Object.hasOwn(item, 'identity') || Object.hasOwn(item, 'backendIdentity')) {
      assert.ok(item.identity && item.backendIdentity, 'Profile manifest requires both identity and independent backend identity');
      const identity = deriveProfileIdentity(item.identity.publicKey, item.identity.protectedHeaders, config);
      assert.deepEqual(normalize(identity), normalize(item.identity), 'Profile manifest identity prediction differs');
      assert.deepEqual(normalize(identity), normalize(item.backendIdentity), 'Profile manifest independent backend differs');
    }
    return [name, { ...item, config }];
  }));
  return { ...manifest, profiles };
}

/** Validate the current configuration recorded with an enrollment. */
export function profileConfigFromCapture(input: any): ProfileIdentityConfig {
  assert.ok(input && typeof input === 'object' && !Array.isArray(input), 'Enrollment profile configuration missing');
  if ('addressDerivationMode' in input) throw new Error('Unsupported configuration field: addressDerivationMode');
  const config = { ...input, index: BigInt(input.index) } as ProfileIdentityConfig;
  bindAddressArtifacts(config);
  return config;
}

export function readTableIdentityManifest(path: string): any {
  const record = readManifest(path);
  assert.ok(record.config && typeof record.config === 'object', 'Identity configuration missing');
  const config = { ...record.config, index: BigInt(record.config.index) };
  assert.equal(config.chainId, record.chainId, 'Manifest/config chains differ');
  verifyAddressArtifactBinding(config, record.artifactBinding);
  if (Object.hasOwn(record, 'artifactIdentity')) assert.deepEqual(record.artifactIdentity, record.artifactBinding.artifactIdentity, 'Manifest artifact identity differs from current factory artifacts');
  assert.ok(record.identity && record.backend, 'Identity manifest requires independent backend identity');
  const identity = deriveTableIdentity(record.identity.publicKey, record.identity.protectedHeaders, config);
  assert.deepEqual(normalize(identity), normalize(record.identity), 'Identity manifest prediction differs');
  assert.deepEqual(normalize(identity), normalize(record.backend), 'Identity manifest independent backend differs');
  return { ...record, config };
}
