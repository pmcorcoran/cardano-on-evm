import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fixtureAddress, signFixture } from '../../tests/fixtures.js';
import { fromHex, toHex } from '../../packages/wallet/src/index.js';
import { enrollCardanoAccount, type EnrollmentTransport } from '../../packages/sdk/src/index.js';
import { json } from '../lib/live-context.js';

// Requires a separate server with --port=4175
// --evidence-dir=.local/reference-http-evidence and NO submitter key.
const origin = process.env.REFERENCE_HTTP_URL ?? 'http://127.0.0.1:4175';
const config = await (await fetch(`${origin}/config`)).json();
assert.equal(config.application, origin); assert.ok(!config.availableModes.includes('direct'));
const address = toHex(fixtureAddress(14));
const wallet = { name: 'GENERATED TEST WALLET', network: async () => 0, addresses: async () => [address], signData: async (_address: string, payload: Uint8Array) => signFixture(payload, fixtureAddress(14), undefined, true) };
async function post(path: string, body: unknown, requestOrigin = origin) {
  return fetch(`${origin}${path}`, { method: 'POST', headers: { origin: requestOrigin, 'content-type': 'application/json' }, body: json(body) });
}
const results: any[] = [];
for (const walletId of ['lace', 'eternl', undefined]) for (const name of ['general', 'targets', 'selectors']) {
  const profile = config.profiles[name]; profile.config.index = BigInt(profile.config.index); let result: any;
  const transport: EnrollmentTransport = {
    challenge: async (a) => (await post(`/enrollment/${name}/challenge`, { address: a })).json(),
    enroll: async (id, signed) => {
      const metadata = walletId ? { walletId, walletName: `GENERATED ${walletId} HTTP TEST`, walletApiVersion: '1' } : {};
      assert.equal((await post(`/enrollment/${name}/enroll`, { id, ...signed, walletId: 'unsupported' })).status, 400);
      const r = await post(`/enrollment/${name}/enroll`, { id, ...signed, ...metadata, walletVersion: 'GENERATED TEST ONLY', userAgent: 'node HTTP acceptance fixture' });
      result = await r.json(); assert.equal(r.status, 200, result.error); return result;
    },
  };
  const options = { wallet, transport, application: origin, cardanoAddress: address, cardanoNetwork: 0 as const, credential: 'stake' as const, config: profile.config };
  const first = await enrollCardanoAccount(options), second = await enrollCardanoAccount(options);
  assert.equal(first.identity.account, second.identity.account);
  const evidence = JSON.parse(readFileSync(result.enrollmentFile, 'utf8'));
  assert.equal(evidence.wallet.id, walletId);
  assert.equal(evidence.wallet.name, walletId ? `GENERATED ${walletId} HTTP TEST` : undefined);
  assert.equal(evidence.wallet.apiVersion, walletId ? '1' : undefined);
  const state = await (await post('/state', { sessionId: result.sessionId })).json();
  assert.equal(state.address, first.identity.account); assert.equal(state.prepared, false); assert.equal(state.deployed, false);
  const denied = await post('/submit', { sessionId: result.sessionId, mode: 'direct' }); assert.equal(denied.status, 400);
  results.push({ walletId: walletId ?? null, profile: name, reportedMetadataVerified: true, stableAccount: state.address, sdkBackendAgreement: true, generatedKeyUnprepared: true, unavailableDirectSubmissionRejected: true });
}
const challenge = await (await post('/enrollment/general/challenge', { address })).json();
const signed = signFixture(fromHex(challenge.payloadHex), fixtureAddress(14), undefined, true);
const concurrent = await Promise.all(Array.from({ length: 10 }, () => post('/enrollment/general/enroll', { id: challenge.id, ...signed, walletVersion: 'GENERATED TEST ONLY' })));
assert.equal(concurrent.filter((r) => r.status === 200).length, 1);
assert.equal((await post('/enrollment/general/challenge', { address }, 'https://untrusted.invalid')).status, 403);
const output = { kind: 'reference-backend-http-generated-wallet', realWallet: false, broadcastTransactions: false, origin, profiles: results, concurrentAttempts: 10, concurrentSuccesses: 1, crossOriginRejected: true };
writeFileSync('evidence/local/reference-http.json', json(output)); console.log(json(output));
