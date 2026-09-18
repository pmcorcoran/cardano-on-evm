import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnrollmentService, MemoryChallengeStore, createEnrollmentHandler, type EnrollmentScope } from '../packages/enrollment/src/index.js';
import { SqliteChallengeStore } from '../packages/enrollment/src/sqlite.js';
import { fromHex, toHex, verifyCip8Signature, decodeCbor, encodeCbor, parseCardanoAddress, type Cbor } from '../packages/wallet/src/index.js';
import { fixtureAddress, fixturePublicKey, signFixture } from './fixtures.js';

const scope: EnrollmentScope = { application: 'https://app.example', baseChainId: 84532, cardanoNetwork: 0, configHash: `0x${'ab'.repeat(32)}` };
function setup(store = new MemoryChallengeStore()) {
  let time = 1000;
  const service = createEnrollmentService({ ...scope, store, now: () => time, ttlMs: 100, deriveIdentity: (verified) => toHex(verified.publicKey) });
  return { service, store, setTime: (value: number) => { time = value; } };
}

test('enrollment validates generated CIP-8 data and consumes only a valid challenge', async () => {
  const { service } = setup();
  const challenge = await service.issue(toHex(fixtureAddress()));
  const signed = signFixture(fromHex(challenge.payloadHex));
  const changedByte = (parseInt(signed.signature.slice(-2), 16) ^ 1).toString(16).padStart(2, '0');
  const corrupted = { ...signed, signature: `${signed.signature.slice(0, -2)}${changedByte}` };
  assert.notEqual(corrupted.signature, signed.signature);
  await assert.rejects(service.enroll(challenge.id, corrupted));
  const result = await service.enroll(challenge.id, signed);
  assert.equal(result.publicKey, toHex(fixturePublicKey)); assert.equal(result.credential, 'payment');
  await assert.rejects(service.enroll(challenge.id, signed), /unavailable|consumed/);
});

test('100 concurrent enrollment requests have exactly one successful consumer', async () => {
  const { service } = setup(); const challenge = await service.issue(toHex(fixtureAddress()));
  const signed = signFixture(fromHex(challenge.payloadHex));
  const results = await Promise.allSettled(Array.from({ length: 100 }, () => service.enroll(challenge.id, signed)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
});

test('expired challenges and expiry during asynchronous derivation are rejected', async () => {
  const state = setup(); const challenge = await state.service.issue(toHex(fixtureAddress()));
  state.setTime(challenge.expiresAt);
  await assert.rejects(state.service.enroll(challenge.id, signFixture(fromHex(challenge.payloadHex))), /expired/);
  let time = 1000; const store = new MemoryChallengeStore();
  const delayed = createEnrollmentService({ ...scope, store, ttlMs: 100, now: () => time, deriveIdentity: () => { time = 1100; return 'identity'; } });
  const other = await delayed.issue(toHex(fixtureAddress()));
  await assert.rejects(delayed.enroll(other.id, signFixture(fromHex(other.payloadHex))), /expired/);
});

test('tampered payloads and every server scope change are rejected', async () => {
  const { service, store } = setup(); const challenge = await service.issue(toHex(fixtureAddress()));
  await assert.rejects(service.enroll(challenge.id, signFixture(new TextEncoder().encode('tampered'))), /payload/);
  for (const change of [{ application: 'https://evil.example' }, { baseChainId: 8453 }, { cardanoNetwork: 1 as const }, { configHash: `0x${'cd'.repeat(32)}` }]) {
    const other = createEnrollmentService({ ...scope, ...change, store, now: () => 1000, deriveIdentity: () => 'unused' });
    await assert.rejects(other.enroll(challenge.id, signFixture(fromHex(challenge.payloadHex))), /scope/);
  }
});

test('wrong address, wrong key, and wrong Cardano network are rejected', async () => {
  const { service } = setup(); const challenge = await service.issue(toHex(fixtureAddress()));
  const payload = fromHex(challenge.payloadHex);
  await assert.rejects(service.issue(toHex(fixtureAddress(6, 1))), /network/);
  await assert.rejects(service.enroll(challenge.id, signFixture(payload, fixtureAddress(14))), /address/);
  await assert.rejects(service.enroll(challenge.id, signFixture(payload, fixtureAddress(), new Uint8Array(32).fill(9))), /credential/);
});

test('base payment, script-stake base payment, enterprise, and explicit reward credential work', async () => {
  for (const type of [0, 2, 6, 14] as const) {
    const { service } = setup(); const address = fixtureAddress(type); const challenge = await service.issue(toHex(address));
    const result = await service.enroll(challenge.id, signFixture(fromHex(challenge.payloadHex), address));
    assert.equal(result.credential, type === 14 ? 'stake' : 'payment');
  }
  // A stake key MUST NOT pass as ownership of a payment address, even if its
  // stake component happens to be the supplied key's hash (mangled address case).
  const address = fixtureAddress(0); address.set(address.slice(1, 29), 29); address.fill(8, 1, 29);
  assert.throws(() => verifyCip8Signature(signFixture(new Uint8Array(), address), { address: toHex(address), network: 0, payload: new Uint8Array() }), /payment credential/);
});

test('generated fixture signature independently verifies using Node/OpenSSL Ed25519', () => {
  const payload = new TextEncoder().encode('independent implementation'); const signed = signFixture(payload);
  const result = verifyCip8Signature(signed, { address: toHex(fixtureAddress()), network: 0, payload });
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), fixturePublicKey]);
  assert.equal(verify(null, result.signStructure, createPublicKey({ key: spki, format: 'der', type: 'spki' }), result.signature), true);
});

test('unsupported COSE algorithms, hashed/detached payloads, duplicates and encodings fail closed', () => {
  const payload = new Uint8Array(32); const signed = signFixture(payload);
  const expected = { address: toHex(fixtureAddress()), network: 0 as const, payload };
  for (const raw of ['ff', '9f00ff', 'a201010102', '1800', '0000', 'd2820000', '7f', '5a7fffffff']) assert.throws(() => decodeCbor(fromHex(raw)));
  for (const raw of ['z1', '0', '0xgg']) assert.throws(() => fromHex(raw));
  const mutate = (change: (a: Cbor[]) => void) => {
    const decoded = decodeCbor(fromHex(signed.signature)) as Cbor[]; change(decoded);
    assert.throws(() => verifyCip8Signature({ ...signed, signature: toHex(encodeCbor(decoded)) }, expected));
  };
  mutate((a) => { a[1] = new Map([['hashed', true]]); });
  mutate((a) => { a[2] = null; });
  mutate((a) => { const h = decodeCbor(a[0] as Uint8Array) as Map<string | number, Cbor>; h.set(1, -7); a[0] = encodeCbor(h); });
  mutate((a) => { a[3] = new Uint8Array(63); });
  assert.throws(() => verifyCip8Signature({ ...signed, signature: `${signed.signature}00` }, expected));
  for (const type of [1, 3, 4, 5, 7, 8, 15]) { const addr = fixtureAddress(); addr[0] = type << 4; assert.throws(() => parseCardanoAddress(toHex(addr)), /Unsupported/); }
});

test('SQLite adapters sharing a database cannot both consume the same challenge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cardano-enrollment-test-'));
  const a = new SqliteChallengeStore(join(dir, 'challenges.sqlite')); const b = new SqliteChallengeStore(join(dir, 'challenges.sqlite'));
  try {
    const one = createEnrollmentService({ ...scope, store: a, now: () => 1000, deriveIdentity: () => 'identity' });
    const two = createEnrollmentService({ ...scope, store: b, now: () => 1000, deriveIdentity: () => 'identity' });
    const challenge = await one.issue(toHex(fixtureAddress()));
    const signed = signFixture(fromHex(challenge.payloadHex));
    const results = await Promise.allSettled([one.enroll(challenge.id, signed), two.enroll(challenge.id, signed)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true }); }
});

test('framework-neutral HTTP handler issues and enrolls; rejects invalid scope/request shapes', async () => {
  const { service } = setup(); const handler = createEnrollmentHandler(service);
  const request = (path: string, body: unknown) => new Request(`https://app.example${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const response = await handler(request('/challenge', { address: toHex(fixtureAddress()) }));
  assert.equal(response.status, 200); const challenge = await response.json();
  const result = await handler(request('/enroll', { id: challenge.id, ...signFixture(fromHex(challenge.payloadHex)) })); assert.equal(result.status, 200);
  assert.equal((await handler(request('/challenge', { address: toHex(fixtureAddress()), application: 'https://evil.example' }))).status, 400);
  assert.equal((await handler(request('/challenge', { address: 'a'.repeat(41_000) }))).status, 400);
});
