import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, toHex, type Hex } from 'viem';
import { fixtureAddress, signFixture } from './fixtures.js';
import { fromHex, toHex as rawHex, verifyCip8Signature } from '../packages/wallet/src/index.js';
import { encodeCalls, operationHash, operationPayload, operationToJson, operationFromJson, type Operation } from '../packages/protocol/src/index.js';
import type { LiveRequest } from '../scripts/lib/live-request.js';
import { liveEvidence } from '../scripts/lib/live-evidence.js';

for (const walletId of ['lace', 'eternl', undefined] as const) test(`${walletId ?? 'legacy unspecified'} live capture accepts only the enrolled key/profile and exact operation, saves once`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'cardano-on-evm-live-test-'));
  try {
    mkdirSync(join(dir, 'requests'));
    const ep = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
    const account = '0x1111111111111111111111111111111111111111';
    const op: Operation = { sender: account, nonce: 0n, callData: encodeCalls([{ target: account, value: 0n, data: '0x' }]), callGasLimit: 250000n, verificationGasLimit: 500000n, preVerificationGas: 100000n, maxFeePerGas: 50000000n, maxPriorityFeePerGas: 2000000n, signature: '0x' };
    const payload = operationPayload(op, 84532, ep); const address = rawHex(fixtureAddress(14));
    const signed = signFixture(fromHex(payload), fixtureAddress(14), undefined, true);
    const verified = verifyCip8Signature(signed, { address, network: 0, payload: fromHex(payload) });
    const request: LiveRequest = { version: 1, id: '01'.repeat(32), createdAt: new Date().toISOString(), title: 'GENERATED TEST ONLY', mode: 'public', chainId: 84532, entryPoint: ep, cardanoAddress: address, cardanoNetwork: 0, credential: 'stake', publicKey: toHex(verified.publicKey), protectedHeaderHash: keccak256(verified.protectedHeaders), userOperationHash: operationHash(op, 84532, ep), payloadHex: payload, operation: operationToJson(op), profile: 'experimental-general', validator: account, sourceCapture: 'generated-test-fixture' };
    const path = join(dir, 'requests', `${request.id}.json`); const write = (r: LiveRequest) => writeFileSync(path, JSON.stringify(r)); write(request);
    const service = liveEvidence(dir); const body = { id: request.id, signed, walletVersion: 'MOCK TEST', userAgent: 'automated generated test', ...(walletId ? { walletId, walletName: `GENERATED ${walletId}`, walletApiVersion: '1' } : {}) };
    for (const invalid of ['typo', '', null, 1, {}, '__proto__']) assert.throws(() => service.capture({ ...body, walletId: invalid }), /wallet ID/);
    assert.throws(() => service.capture({ ...body, walletApiVersion: 1 }), /walletApiVersion/);
    if (walletId) {
      write({ ...request, walletId });
      assert.throws(() => service.capture({ ...body, walletId: walletId === 'lace' ? 'eternl' : 'lace' }), /differs from enrollment/);
    }
    assert.throws(() => service.capture({ ...body, id: '../escape' }));
    assert.throws(() => service.capture({ ...body, signed: signFixture(new Uint8Array(32), fixtureAddress(14), undefined, true) }));
    assert.throws(() => service.capture({ ...body, signed: signFixture(fromHex(payload), fixtureAddress(14)) }), /profile changed/);
    write({ ...request, operation: { ...request.operation, nonce: '1' } }); assert.throws(() => service.capture(body), /authorization payload/); write(request);
    write({ ...request, publicKey: `0x${'00'.repeat(32)}` as Hex }); assert.throws(() => service.capture(body), /key or protected header/); write(request);
    const result = service.capture(body); const saved = JSON.parse(readFileSync(result.file, 'utf8'));
    assert.equal(operationHash(operationFromJson(saved.operation), 84532, ep), request.userOperationHash);
    assert.equal(saved.credentialAndContextVerified, true); assert.equal(saved.submitted, false);
    assert.equal(saved.wallet.id, walletId);
    assert.equal(saved.wallet.name, walletId ? `GENERATED ${walletId}` : undefined);
    assert.equal(saved.wallet.apiVersion, walletId ? '1' : undefined);
    assert.equal(saved.wallet.release, 'MOCK TEST');
    assert.throws(() => service.capture(body), /EEXIST/);
    assert.equal(service.list()[0]!.signed, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
