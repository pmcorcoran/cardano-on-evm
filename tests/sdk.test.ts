import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, stringToHex, type Hex } from 'viem';
import { createTableEnrollmentService, MemoryChallengeStore, createEnrollmentHandler } from '../packages/enrollment/src/index.js';
import { constructOperation, enrollCardanoAccount, httpEnrollmentTransport, signOperation, type TableIdentityConfig } from '../packages/sdk/src/index.js';
import { toHex as rawHex, type CardanoWalletAdapter } from '../packages/wallet/src/index.js';
import { operationHash } from '../packages/protocol/src/index.js';
import { fixtureAddress, signFixture } from './fixtures.js';

const application = 'http://127.0.0.1:4173';
const config: TableIdentityConfig = { chainId: 84532, entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032', kernelImplementation: '0x0000000000000000000000000000000000000102', kernelFactory: '0x0000000000000000000000000000000000000103', tableFactory: '0x0000000000000000000000000000000000000104', validatorCreationCode: '0x60006000f3', namespace: keccak256(stringToHex('sdk generated test')), index: 0n };
function fixture() {
  let signCalls = 0;
  const address = rawHex(fixtureAddress(14));
  const wallet: CardanoWalletAdapter = { name: 'generated test', network: async () => 0, addresses: async (credential) => credential === 'stake' ? [address] : [], signData: async (claimed, payload) => { assert.equal(claimed, address); signCalls++; return signFixture(payload, fixtureAddress(14), undefined, true); } };
  const service = createTableEnrollmentService({ application, cardanoNetwork: 0, config, store: new MemoryChallengeStore() });
  const handler = createEnrollmentHandler(service);
  const fetcher = ((url: string | URL | Request, init: RequestInit) => handler(new Request(url, init))) as typeof fetch;
  const transport = httpEnrollmentTransport(`${application}/`, fetcher);
  return { wallet, service, transport, address, signCalls: () => signCalls, options: { wallet, transport, application, cardanoAddress: address, cardanoNetwork: 0 as const, credential: 'stake' as const, config } };
}
test('SDK enrolls through backend HTTP handlers and predicts the same address across fresh challenges', async () => {
  const f = fixture(); const a = await enrollCardanoAccount(f.options); const b = await enrollCardanoAccount(f.options);
  assert.deepEqual(a, b); assert.equal(f.signCalls(), 2); assert.equal(a.credential, 'stake');
  assert.deepEqual(a.config, config);
  assert.ok(Object.isFrozen(a.config)); assert.ok(Object.isFrozen(a.identity));
});
test('SDK rejects altered enrollment scope/payload before a wallet prompt', async () => {
  const f = fixture();
  for (const mutate of [(ch: any) => ({ ...ch, application: 'https://evil.example' }), (ch: any) => ({ ...ch, baseChainId: 8453 }), (ch: any) => ({ ...ch, payloadHex: '00' }), (ch: any) => ({ ...ch, expiresAt: 0 })]) {
    const transport = { ...f.transport, challenge: async (address: string) => mutate(await f.transport.challenge(address)) };
    await assert.rejects(enrollCardanoAccount({ ...f.options, transport }));
  }
  assert.equal(f.signCalls(), 0);
  const dishonest = { ...f.transport, enroll: async (id: string, signed: Parameters<typeof f.transport.enroll>[1]) => { const result = await f.transport.enroll(id, signed); return { ...result, identity: { ...result.identity, account: '0x1111111111111111111111111111111111111111' as const } }; } };
  await assert.rejects(enrollCardanoAccount({ ...f.options, transport: dishonest }), /derivation disagree/);
});
test('SDK operation signing fixes the reviewed snapshot and rejects other account/deployment contexts', async () => {
  const f = fixture(); const account = await enrollCardanoAccount(f.options);
  const operation = constructOperation(account, { calls: [{ target: config.entryPoint, value: 0n, data: '0x' }], nonce: 0n, deploy: true, gas: { callGasLimit: 250000n, verificationGasLimit: 500000n, preVerificationGas: 100000n }, fees: { maxFeePerGas: 50000000n, maxPriorityFeePerGas: 2000000n } });
  const originalHash = operationHash(operation, config.chainId, config.entryPoint);
  const signing = signOperation(account, operation, f.wallet);
  operation.callData = '0x1234'; operation.maxFeePerGas = 60000000n;
  const signed = await signing;
  assert.equal(operationHash(signed.operation, config.chainId, config.entryPoint), originalHash);
  assert.notEqual(signed.operation.signature, '0x');
  const before = f.signCalls();
  await assert.rejects(signOperation(account, { ...signed.operation, sender: config.entryPoint }, f.wallet), /different Cardano account/);
  await assert.rejects(signOperation(account, { ...signed.operation, factoryData: '0x1234' as Hex }, f.wallet), /different deployment/);
  await assert.rejects(signOperation(account, signed.operation, { ...f.wallet, network: async () => 1 }), /network differs/);
  assert.equal(f.signCalls(), before);
});
