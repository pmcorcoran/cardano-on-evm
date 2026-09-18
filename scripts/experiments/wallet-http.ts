import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixtureAddress, signFixture } from '../../tests/fixtures.js';
import { fromHex, toHex } from '../../packages/wallet/src/index.js';
import { readWalletCapture } from '../lib/wallet-capture.js';

const origin = process.env.WALLET_LAB_URL ?? 'http://127.0.0.1:4173';
if (new URL(origin).hostname !== '127.0.0.1') throw new Error('Generated acceptance requires loopback');
const post = (path: string, body: unknown) => fetch(origin + path, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const results = [];
for (const walletId of ['lace', 'eternl', undefined]) for (const type of [14, 0] as const) {
  const address = fixtureAddress(type), credential = type === 14 ? 'stake' : 'payment';
  const challengeResponse = await post('/lab/challenge', { address: toHex(address), network: 0, credential });
  assert.equal(challengeResponse.status, 200); const challenge = await challengeResponse.json();
  assert.equal(fromHex(challenge.operation.payloadHex).length, 32);
  const body = { id: challenge.id, network: 0, credential, ...(walletId ? { walletId, walletName: `GENERATED ${walletId} HTTP TEST`, walletApiVersion: '1' } : {}), walletRelease: 'GENERATED TEST ONLY', userAgent: 'node loopback HTTP acceptance', enrollment: signFixture(fromHex(challenge.payloadHex), address, undefined, true), operation: signFixture(fromHex(challenge.operation.payloadHex), address, undefined, true) };
  const mismatch = await post('/lab/capture', { ...body, operation: signFixture(fromHex(challenge.operation.payloadHex), address) });
  assert.equal(mismatch.status, 400); assert.match((await mismatch.json()).error, /protected-header profiles differ/);
  assert.equal((await post('/lab/capture', { ...body, walletId: 'unknown' })).status, 400);
  const captured = await post('/lab/capture', body); assert.equal(captured.status, 200, JSON.stringify(await captured.clone().json()));
  const result = await captured.json(), saved = JSON.parse(readFileSync(result.file, 'utf8'));
  assert.equal(saved.wallet.id, walletId); assert.equal(saved.wallet.name, body.walletName);
  assert.equal(saved.wallet.apiVersion, body.walletApiVersion); assert.equal(saved.wallet.release, body.walletRelease);
  const verified = readWalletCapture(result.file); assert.ok(verified.operation);
  assert.equal(toHex(verified.operation.protectedHeaders), toHex(verified.enrollment.protectedHeaders));
  assert.equal((await post('/lab/capture', body)).status, 400);
  results.push({ walletId: walletId ?? null, credential, file: result.file, sha256: verified.sha256 });
}
console.log(JSON.stringify({ kind: 'generated-wallet-http-acceptance', realWallet: false, exactHeaderMismatchRejectedBeforeConsumption: true, invalidIdsRejected: true, legacyUnspecified: true, results }, null, 2));
