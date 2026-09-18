import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, stringToHex, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { deriveProfileIdentity, profileConfigHash, encodeTargetAllowlist, encodeSelectorAllowlist, decodeRestrictedCalls, type ProfileIdentityConfig } from '../packages/protocol/src/index.js';
import { backendProfileConfigHash, deriveBackendProfileIdentity, createProfileEnrollmentService, createEnrollmentHandler, MemoryChallengeStore } from '../packages/enrollment/src/index.js';
import { constructOperation, enrollCardanoAccount, httpEnrollmentTransport, signOperation, accountPreparation, accountFactory } from '../packages/sdk/src/index.js';
import { fixturePublicKey, fixtureAddress, signFixture } from './fixtures.js';
import { toHex as rawHex, type CardanoWalletAdapter } from '../packages/wallet/src/index.js';

const addr = (n: number) => toHex(n, { size: 20 }) as Address;
const zeroHash = toHex(0n, { size: 32 });
const config: ProfileIdentityConfig = { profile: 'restricted', chainId: 84532, entryPoint: addr(11), kernelImplementation: addr(12), tableFactory: addr(13), profilePreparationFactory: addr(14), validatorCreationCode: '0x60016000', profileFactoryCreationCode: '0x60026000', namespace: keccak256(stringToHex('profile tests')), index: 9n, policy: addr(15), policyCodeHash: keccak256('0x6003'), policyConfig: encodeTargetAllowlist([addr(41), addr(40)]) };
const compare = (first: object, second: object) => assert.deepEqual(JSON.parse(JSON.stringify(first).toLowerCase()), JSON.parse(JSON.stringify(second).toLowerCase()));
test('independent SDK/backend profile identity agrees across encoding boundaries and both profiles', () => {
  for (const length of [1, 23, 24, 31, 32, 33, 74, 128, 255, 256]) for (const profile of ['restricted', 'general'] as const) {
    const chosen = profile === 'general' ? { ...config, profile, policy: zeroAddress, policyCodeHash: zeroHash, policyConfig: '0x' as Hex } : { ...config };
    const header = `0x${'42'.repeat(length)}` as Hex;
    assert.equal(profileConfigHash(chosen), backendProfileConfigHash(chosen));
    compare(deriveProfileIdentity(toHex(fixturePublicKey), header, chosen), deriveBackendProfileIdentity(toHex(fixturePublicKey), header, chosen));
  }
});
test('every profile configuration input is committed and the address is independent of chain and endpoint', () => {
  const header: Hex = '0x010203';
  const initial = deriveProfileIdentity(toHex(fixturePublicKey), header, config);
  const mutations: Partial<ProfileIdentityConfig>[] = [
    { chainId: 8453 }, { entryPoint: addr(90) }, { kernelImplementation: addr(91) }, { tableFactory: addr(92) }, { profilePreparationFactory: addr(93) },
    { validatorCreationCode: '0x6004' }, { profileFactoryCreationCode: '0x6005' }, { namespace: zeroHash }, { index: 10n },
    { policy: addr(94) }, { policyConfig: encodeTargetAllowlist([addr(41)]) }, { policyCodeHash: keccak256('0x6006') },
    { profile: 'general', policy: zeroAddress, policyCodeHash: zeroHash, policyConfig: '0x' },
  ];
  for (const change of mutations) {
    const chosen = { ...config, ...change };
    const sdk = deriveProfileIdentity(toHex(fixturePublicKey), header, chosen);
    const backend = deriveBackendProfileIdentity(toHex(fixturePublicKey), header, chosen);
    assert.notEqual(sdk.configHash, initial.configHash, Object.keys(change).join(','));
    compare(sdk, backend);
    if ('chainId' in change) assert.deepEqual({ ...sdk, configHash: initial.configHash }, initial);
    else assert.notEqual(sdk.account, initial.account, Object.keys(change).join(','));
  }
});
test('profile policy configuration is explicit, bounded and canonical', () => {
  assert.equal(encodeTargetAllowlist([addr(2), addr(1)]), encodeTargetAllowlist([addr(1), addr(2)]));
  assert.throws(() => encodeTargetAllowlist([addr(1), addr(1)]));
  assert.throws(() => encodeTargetAllowlist([zeroAddress]));
  assert.throws(() => encodeSelectorAllowlist([{ target: addr(1), selectors: [], allowEmpty: false, allowValue: false }]));
  assert.throws(() => encodeSelectorAllowlist([{ target: addr(1), selectors: ['0x1234'], allowEmpty: false, allowValue: false }]));
  const selectors = [{ target: addr(1), selectors: ['0x01020304', '0x05060708'] as Hex[], allowEmpty: false, allowValue: false }];
  assert.equal(encodeSelectorAllowlist(selectors), encodeSelectorAllowlist([{ ...selectors[0]!, selectors: [...selectors[0]!.selectors].reverse() }]));
  for (const change of [{ profile: 'general' as const }, { policy: zeroAddress }, { policyCodeHash: zeroHash }, { profilePreparationFactory: zeroAddress }, { chainId: 0 }, { index: -1n }]) {
    assert.throws(() => profileConfigHash({ ...config, ...change }));
    assert.throws(() => backendProfileConfigHash({ ...config, ...change }));
  }
});
test('restricted enrollment, construction and signing use independent backend identity and mandatory hook', async () => {
  const application = 'http://127.0.0.1:4173';
  const address = rawHex(fixtureAddress(14)); let signedCount = 0;
  const wallet: CardanoWalletAdapter = { name: 'GENERATED TEST FIXTURE', network: async () => 0, addresses: async () => [address], signData: async (claimed, payload) => { assert.equal(claimed, address); signedCount++; return signFixture(payload, fixtureAddress(14), undefined, true); } };
  const service = createProfileEnrollmentService({ application, config, cardanoNetwork: 0, store: new MemoryChallengeStore() });
  const handler = createEnrollmentHandler(service);
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init))) as typeof fetch;
  const options = { wallet, application, config, cardanoAddress: address, cardanoNetwork: 0 as const, credential: 'stake' as const, transport: httpEnrollmentTransport(`${application}/`, fetcher) };
  const account = await enrollCardanoAccount(options); const again = await enrollCardanoAccount(options);
  assert.deepEqual(account, again); assert.equal(account.profile, 'restricted');
  const calls = [{ target: addr(40), value: 1n, data: '0x' as Hex }];
  const operation = constructOperation(account, { calls, nonce: 0n, deploy: true, gas: { callGasLimit: 600000n, verificationGasLimit: 500000n, preVerificationGas: 100000n }, fees: { maxFeePerGas: 10n, maxPriorityFeePerGas: 1n } });
  assert.deepEqual(decodeRestrictedCalls(operation.callData), calls);
  assert.equal(operation.factory, accountFactory(account));
  assert.equal(accountPreparation(account).to, config.profilePreparationFactory);
  const signed = await signOperation(account, operation, wallet);
  assert.notEqual(signed.operation.signature, '0x'); assert.equal(signed.operation.callData, operation.callData);
  const before = signedCount;
  await assert.rejects(signOperation(account, { ...operation, callData: `0x${operation.callData.slice(10)}` }, wallet), /prefix/);
  const self = constructOperation(account, { calls: [{ target: account.identity.account, value: 0n, data: '0x' }], nonce: 0n, deploy: true, gas: { callGasLimit: 600000n, verificationGasLimit: 500000n, preVerificationGas: 100000n }, fees: { maxFeePerGas: 10n, maxPriorityFeePerGas: 1n } });
  await assert.rejects(signOperation(account, self, wallet), /themselves/); assert.equal(signedCount, before);
});
