import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, keccak256, stringToHex, toHex, zeroAddress, type Address, type Hex } from 'viem';
import {
  deriveProfileIdentity, deriveTableIdentity, encodeTargetAllowlist, identityAbi, operationHash, operationPayload,
  profileConfigHash, tableConfigHash,
  type ProfileIdentityConfig, type TableIdentityConfig,
} from '@cardano-on-evm/protocol';
import {
  accountFactory, accountFromVerifiedKey, accountPreparation, constructOperation, enrollCardanoAccount,
  signOperation,
  type AccountConfig, type ResolvedAccountConfig,
} from '@cardano-on-evm/sdk';
import { fromHex, toHex as rawHex, verifyCip8Signature, type CardanoWalletAdapter } from '@cardano-on-evm/wallet';
import { fixtureAddress, signFixture } from './fixtures.js';

const addr = (number: number) => toHex(number, { size: 20 }) as Address;
const zeroHash = toHex(0n, { size: 32 });
const table: TableIdentityConfig = {
  chainId: 31337, entryPoint: addr(11), kernelImplementation: addr(12), kernelFactory: addr(13), tableFactory: addr(14),
  validatorCreationCode: '0x60016000', namespace: keccak256(stringToHex('account API generated fixture')), index: 1n,
};
const general: ProfileIdentityConfig = {
  profile: 'general', chainId: table.chainId, entryPoint: table.entryPoint, kernelImplementation: table.kernelImplementation,
  tableFactory: table.tableFactory, validatorCreationCode: table.validatorCreationCode, namespace: table.namespace, index: table.index,
  profilePreparationFactory: addr(15), profileFactoryCreationCode: '0x60026000', policy: zeroAddress, policyCodeHash: zeroHash, policyConfig: '0x',
};
const restricted: ProfileIdentityConfig = { ...general, profile: 'restricted', policy: addr(16), policyCodeHash: keccak256('0x6003'), policyConfig: encodeTargetAllowlist([addr(17)]) };
const configs: AccountConfig[] = [table, general, restricted];
const enrollmentPayload = Uint8Array.of(1, 2, 3);
const cardanoAddress = rawHex(fixtureAddress(14));
const verified = verifyCip8Signature(signFixture(enrollmentPayload, fixtureAddress(14), undefined, true), { address: cardanoAddress, network: 0, payload: enrollmentPayload });
const key = toHex(verified.publicKey);
const headers = toHex(verified.protectedHeaders);
const derive = (config: AccountConfig) => 'profile' in config ? deriveProfileIdentity(key, headers, config) : deriveTableIdentity(key, headers, config);
const hashConfig = (config: AccountConfig) => 'profile' in config ? profileConfigHash(config) : tableConfigHash(config);
test('resolved account configurations are read-only frozen snapshots', () => {
  for (const config of configs) {
    const account = accountFromVerifiedKey(verified, config);
    const resolved: ResolvedAccountConfig = account.config;
    assert.deepEqual(resolved, config);
    assert.ok(Object.isFrozen(resolved));
    assert.equal(Object.hasOwn(resolved, 'addressDerivationMode'), false);
    const mutable = { ...config };
    const snapshot = accountFromVerifiedKey(verified, mutable);
    mutable.chainId = 31338;
    assert.equal(snapshot.config.chainId, config.chainId);
  }
});

test('unsupported configuration fields reject before enrollment transport or operation signing', async () => {
  let challengeCalls = 0; let signingCalls = 0; let walletCalls = 0;
  const wallet: CardanoWalletAdapter = { name: 'generated configuration validation', network: async () => { walletCalls++; return 0; }, addresses: async () => { walletCalls++; return [cardanoAddress]; }, signData: async () => { signingCalls++; throw new Error('Unexpected signing'); } };
  const transport = { challenge: async () => { challengeCalls++; throw new Error('Unexpected challenge'); }, enroll: async () => { throw new Error('Unexpected enrollment'); } };
  for (const value of [undefined, 'portable', null, '', 'unsupported', false, 0, {}, []]) for (const original of configs) {
    const account = accountFromVerifiedKey(verified, original);
    const operation = constructOperation(account, { calls: [{ target: addr(17), value: 0n, data: '0x' }], nonce: 0n, deploy: false, gas: { callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n }, fees: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n } });
    const candidates = [
      { ...original, addressDerivationMode: value },
      Object.assign(Object.create({ addressDerivationMode: value }), original),
      Object.defineProperty({ ...original }, 'addressDerivationMode', { value, enumerable: false }),
    ] as AccountConfig[];
    for (const config of candidates) {
      assert.throws(() => hashConfig(config), /Unsupported configuration field: addressDerivationMode/);
      assert.throws(() => derive(config), /Unsupported configuration field: addressDerivationMode/);
      assert.throws(() => accountFromVerifiedKey(verified, config), /Unsupported configuration field: addressDerivationMode/);
      await assert.rejects(enrollCardanoAccount({ wallet, transport, application: 'https://account.example', cardanoAddress, cardanoNetwork: 0, credential: 'stake', config }), /Unsupported configuration field: addressDerivationMode/);
      await assert.rejects(signOperation({ ...account, config }, operation, wallet), /Unsupported configuration field: addressDerivationMode/);
    }
  }
  assert.equal(challengeCalls, 0); assert.equal(signingCalls, 0); assert.equal(walletCalls, 0);
});

test('portable complete identities and factory calls are chain independent while enrollment hashes remain chain bound', () => {
  for (const original of configs) {
    const firstConfig = { ...original };
    const secondConfig = { ...firstConfig, chainId: 31338 };
    const first = accountFromVerifiedKey(verified, firstConfig);
    const second = accountFromVerifiedKey(verified, secondConfig);
    assert.notEqual(first.identity.configHash, second.identity.configHash);
    assert.equal(accountFactory(first), accountFactory(second));
    assert.deepEqual(accountPreparation(first), accountPreparation(second));
    assert.deepEqual({ ...first.identity, configHash: second.identity.configHash }, second.identity);
    assert.equal(first.identity.accountSalt, second.identity.accountSalt);
    assert.equal(first.identity.account, second.identity.account);
    assert.equal(first.identity.factoryData, second.identity.factoryData);
    assert.notEqual(first.identity.accountSalt, first.identity.configHash);
    if (!('profile' in original)) {
      const decoded = decodeFunctionData({ abi: identityAbi, data: first.identity.factoryData });
      assert.equal(decoded.functionName, 'createAccount');
      assert.equal(decoded.args[1], first.identity.accountSalt);
    }
  }
});

test('portable derivation retains every address-affecting deployment input in the complete address', () => {
  for (const original of configs) {
    const config = { ...original };
    const baseline = derive(config);
    const mutations: Partial<AccountConfig>[] = [
      { kernelImplementation: addr(91) }, { tableFactory: addr(92) }, { validatorCreationCode: '0x60046000' },
      { namespace: zeroHash }, { index: 2n },
      ...('profile' in config ? [{ profilePreparationFactory: addr(93) }, { profileFactoryCreationCode: '0x60056000' as Hex }] : [{ entryPoint: addr(90) }, { kernelFactory: addr(93) }]),
      ...('profile' in config && config.profile === 'restricted' ? [{ policy: addr(94) }, { policyCodeHash: keccak256('0x6006') }, { policyConfig: encodeTargetAllowlist([addr(95)]) }] : []),
    ];
    for (const mutation of mutations) {
      const changed = derive({ ...config, ...mutation } as AccountConfig);
      assert.notEqual(changed.configHash, baseline.configHash, Object.keys(mutation).join(','));
      assert.notEqual(changed.account, baseline.account, Object.keys(mutation).join(','));
    }
    if ('profile' in config) {
      const changed = derive({ ...config, entryPoint: addr(90) });
      assert.notEqual(changed.configHash, baseline.configHash);
      assert.notEqual(changed.validator, baseline.validator);
      assert.notEqual(changed.account, baseline.account);
    }
  }
});

test('real SDK signing payloads and operation digests stay chain bound for all profiles', async () => {
  const signedPayloads: Hex[] = [];
  const wallet: CardanoWalletAdapter = {
    name: 'generated chain signing', network: async () => 0, addresses: async () => [cardanoAddress],
    signData: async (address, payload) => { assert.equal(address, cardanoAddress); signedPayloads.push(toHex(payload)); return signFixture(payload, fixtureAddress(14), undefined, true); },
  };
  for (const original of configs) {
    const first = accountFromVerifiedKey(verified, { ...original });
    const second = accountFromVerifiedKey(verified, { ...original, chainId: 31338 });
    const options = { calls: [{ target: addr(17), value: 0n, data: '0x' as Hex }], nonce: 0n, deploy: true, gas: { callGasLimit: 250000n, verificationGasLimit: 500000n, preVerificationGas: 100000n }, fees: { maxFeePerGas: 10n, maxPriorityFeePerGas: 1n } };
    const firstOperation = constructOperation(first, options);
    const secondOperation = constructOperation(second, options);
    assert.deepEqual(firstOperation, secondOperation);
    assert.notEqual(operationHash(firstOperation, first.config.chainId, first.config.entryPoint), operationHash(firstOperation, second.config.chainId, second.config.entryPoint));
    const firstSigned = await signOperation(first, firstOperation, wallet);
    const secondSigned = await signOperation(second, secondOperation, wallet);
    assert.equal(firstSigned.payload, operationPayload(firstOperation, first.config.chainId, first.config.entryPoint));
    assert.equal(secondSigned.payload, operationPayload(secondOperation, second.config.chainId, second.config.entryPoint));
    assert.deepEqual(signedPayloads.slice(-2), [firstSigned.payload, secondSigned.payload]);
    assert.notEqual(firstSigned.payload, secondSigned.payload);
    assert.notEqual(firstSigned.operation.signature, secondSigned.operation.signature);
    assert.throws(() => verifyCip8Signature(firstSigned.authorization, { address: cardanoAddress, network: 0, payload: fromHex(secondSigned.payload) }), /payload/i);
  }
  assert.equal(signedPayloads.length, 6);
});

test('all profiles require a valid chain for derivation, enrollment, operation hashing and signing', async () => {
  let challengeCalls = 0; let signingCalls = 0;
  const wallet: CardanoWalletAdapter = { name: 'generated chain validation', network: async () => 0, addresses: async () => [cardanoAddress], signData: async () => { signingCalls++; throw new Error('Unexpected signing'); } };
  const transport = { challenge: async () => { challengeCalls++; throw new Error('Unexpected challenge'); }, enroll: async () => { throw new Error('Unexpected enrollment'); } };
  for (const original of configs) {
    const account = accountFromVerifiedKey(verified, { ...original });
    const operation = constructOperation(account, { calls: [{ target: addr(17), value: 0n, data: '0x' }], nonce: 0n, deploy: false, gas: { callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n }, fees: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n } });
    for (const chainId of [undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const config = { ...original, chainId } as unknown as AccountConfig;
      assert.throws(() => hashConfig(config), /chain/i);
      assert.throws(() => derive(config), /chain/i);
      assert.throws(() => accountFromVerifiedKey(verified, config), /chain/i);
      assert.throws(() => operationHash(operation, chainId as number, account.config.entryPoint), /chain/i);
      assert.throws(() => operationPayload(operation, chainId as number, account.config.entryPoint), /chain/i);
      await assert.rejects(enrollCardanoAccount({ wallet, transport, application: 'https://account.example', cardanoAddress, cardanoNetwork: 0, credential: 'stake', config }), /chain/i);
      await assert.rejects(signOperation({ ...account, config: { ...account.config, chainId: chainId as number } }, operation, wallet), /chain/i);
    }
  }
  assert.equal(challengeCalls, 0);
  assert.equal(signingCalls, 0);
});
