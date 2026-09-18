import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { toHex, keccak256, stringToHex, type Hex } from 'viem';
import { deriveTableIdentity, kernelProxyInitCode, type TableIdentityConfig } from '../packages/protocol/src/index.js';
import { deriveBackendTableIdentity } from '../packages/enrollment/src/identity.js';

const config: TableIdentityConfig = {
  chainId: 84532, entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  kernelImplementation: '0x0000000000000000000000000000000000000102',
  kernelFactory: '0x0000000000000000000000000000000000000103',
  tableFactory: '0x0000000000000000000000000000000000000104',
  validatorCreationCode: '0x600160005560006000f3', namespace: keccak256(stringToHex('identity test')), index: 0n,
};
const lower = (value: unknown) => JSON.stringify(value).toLowerCase();
const key = toHex(ed25519.getPublicKey(new Uint8Array(32).fill(51)));
test('independent SDK and backend agree across key, header and ABI padding variations', () => {
  let count = 0;
  for (const seed of [1, 7, 31, 127]) for (const length of [1, 31, 32, 33, 74, 130, 255, 256]) {
    const publicKey = toHex(ed25519.getPublicKey(new Uint8Array(32).fill(seed)));
    const headers = toHex(new Uint8Array(length).fill(seed));
    const inputs = { ...config, index: BigInt(seed) };
    assert.equal(lower(deriveTableIdentity(publicKey, headers, inputs)), lower(deriveBackendTableIdentity(publicKey, headers, inputs)));
    count++;
  }
  assert.equal(count, 32);
  assert.equal((kernelProxyInitCode(config.kernelImplementation).length - 2) / 2, 95);
});
test('every address input changes the predicted account while the chain only changes enrollment', () => {
  const baseline = deriveTableIdentity(key, '0x0102', config);
  const other = '0x1111111111111111111111111111111111111111' as const;
  for (const mutation of [
    { entryPoint: other }, { kernelImplementation: other }, { kernelFactory: other }, { tableFactory: other },
    { validatorCreationCode: '0x600260005560006000f3' as Hex }, { namespace: toHex(1n, { size: 32 }) }, { index: 1n },
  ]) {
    const input = { ...config, ...mutation }; const identity = deriveTableIdentity(key, '0x0102', input);
    assert.notEqual(identity.account, baseline.account);
    assert.equal(lower(identity), lower(deriveBackendTableIdentity(key, '0x0102', input)));
  }
  assert.notEqual(deriveTableIdentity(key, '0x010203', config).account, baseline.account);
  assert.notEqual(deriveTableIdentity(toHex(ed25519.getPublicKey(new Uint8Array(32).fill(52))), '0x0102', config).account, baseline.account);
  assert.deepEqual(deriveTableIdentity(key, '0x0102', { ...config }), baseline);
  const otherChain = deriveTableIdentity(key, '0x0102', { ...config, chainId: 8453 });
  assert.notEqual(otherChain.configHash, baseline.configHash);
  assert.deepEqual({ ...otherChain, configHash: baseline.configHash }, baseline);
});
test('identity derivation rejects incomplete configuration and unsupported keys', () => {
  for (const derive of [deriveTableIdentity, deriveBackendTableIdentity]) {
    for (const change of [{ chainId: 0 }, { index: -1n }, { index: 1n << 256n }, { namespace: '0x00' as Hex }, { validatorCreationCode: '0x' as Hex }]) assert.throws(() => derive(key, '0x01', { ...config, ...change }));
    assert.throws(() => derive(toHex(new Uint8Array(32)), '0x01', config));
    assert.throws(() => derive(key, '0x', config));
  }
});
