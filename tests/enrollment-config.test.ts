import test from 'node:test';
import assert from 'node:assert/strict';
import {
  backendProfileConfigHash, backendTableConfigHash,
  createEnrollmentHandler, createProfileEnrollmentService, createTableEnrollmentService,
  deriveBackendProfileIdentity, deriveBackendTableIdentity, MemoryChallengeStore,
} from '../packages/enrollment/src/index.js';
import {
  enrollCardanoAccount, httpEnrollmentTransport,
  type AccountConfig, type EnrollmentTransport,
} from '../packages/sdk/src/index.js';
import { toHex, type CardanoWalletAdapter } from '../packages/wallet/src/index.js';
import { fixtureAddress, fixturePublicKey, signFixture } from './fixtures.js';

type Hex = `0x${string}`;
type Profile = 'general' | 'restricted' | 'experimental-general';
const profiles = ['general', 'restricted', 'experimental-general'] as const;
const application = 'http://127.0.0.1:4173';
const address = toHex(fixtureAddress(14));
const publicKey: Hex = `0x${toHex(fixturePublicKey)}`;
const headers: Hex = '0x010203';
const deployment = (number: number): Hex => `0x${number.toString(16).padStart(40, '0')}`;
const configFor = (profile: Profile): AccountConfig => {
  const common = {
    chainId: 84532, entryPoint: deployment(11), kernelImplementation: deployment(12),
    tableFactory: deployment(13), validatorCreationCode: '0x60016000' as Hex,
    namespace: `0x${'ab'.repeat(32)}` as Hex, index: 9n,
  };
  return profile === 'experimental-general' ? { ...common, kernelFactory: deployment(14) } : {
    ...common, profile, profilePreparationFactory: deployment(14), profileFactoryCreationCode: '0x60026000',
    policy: deployment(profile === 'general' ? 0 : 15),
    policyCodeHash: `0x${(profile === 'general' ? '00' : 'cc').repeat(32)}`,
    policyConfig: profile === 'general' ? '0x' : '0x123456',
  };
};
const derive = (config: AccountConfig, key = publicKey, protectedHeaders = headers) => 'profile' in config
  ? deriveBackendProfileIdentity(key, protectedHeaders, config)
  : deriveBackendTableIdentity(key, protectedHeaders, config);
const configHash = (config: AccountConfig) => 'profile' in config ? backendProfileConfigHash(config) : backendTableConfigHash(config);
const serviceFor = (config: AccountConfig, store = new MemoryChallengeStore()) => 'profile' in config
  ? createProfileEnrollmentService({ application, config, cardanoNetwork: 0, store })
  : createTableEnrollmentService({ application, config, cardanoNetwork: 0, store });
const canonical = (value: unknown) => JSON.parse(JSON.stringify(value).toLowerCase()) as unknown;

function enrollmentFixture(sdkConfig: AccountConfig, backendConfig: AccountConfig) {
  let signerCalls = 0;
  let enrollCalls = 0;
  let challengeCalls = 0;
  const wallet: CardanoWalletAdapter = {
    name: 'EPHEMERAL TEST FIXTURE', network: async () => 0,
    addresses: async (credential) => credential === 'stake' ? [address] : [],
    signData: async (claimed, payload) => {
      assert.equal(claimed, address);
      signerCalls++;
      return signFixture(payload, fixtureAddress(14), undefined, true);
    },
  };
  const handler = createEnrollmentHandler(serviceFor(backendConfig));
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init))) as typeof fetch;
  const http = httpEnrollmentTransport(`${application}/`, fetcher);
  const transport: EnrollmentTransport = {
    challenge: async (claimed) => { challengeCalls++; return http.challenge(claimed); },
    enroll: async (id, signed) => { enrollCalls++; return http.enroll(id, signed); },
  };
  return {
    options: { wallet, transport, application, cardanoAddress: address, cardanoNetwork: 0 as const, credential: 'stake' as const, config: sdkConfig },
    counters: () => ({ signerCalls, enrollCalls, challengeCalls }),
  };
}

for (const profile of profiles) {
  test(`${profile}: HTTP enrollment signs once and freezes its validated configuration`, async (t) => {
    const config = configFor(profile);
    const fixture = enrollmentFixture(config, config);
    const account = await enrollCardanoAccount(fixture.options);
    assert.equal(account.profile, profile);
    assert.deepEqual(account.config, config);
    assert.ok(Object.isFrozen(account.config));
    assert.deepEqual(canonical(account.identity), canonical(derive(config, account.publicKey, account.identity.protectedHeaders)));
    assert.deepEqual(fixture.counters(), { signerCalls: 1, enrollCalls: 1, challengeCalls: 1 });
    t.diagnostic(JSON.stringify({ profile, success: true, ...fixture.counters() }));
  });

  test(`${profile}: configuration mismatches reject before signing or enrollment submission`, async () => {
    const sdkConfig = configFor(profile);
    for (const change of [{ chainId: 8453 }, { index: 10n }, { entryPoint: deployment(22) }, { validatorCreationCode: '0x60036000' as Hex }]) {
      const backendConfig = { ...sdkConfig, ...change };
      assert.notEqual(configHash(sdkConfig), configHash(backendConfig));
      const fixture = enrollmentFixture(sdkConfig, backendConfig);
      await assert.rejects(enrollCardanoAccount(fixture.options), /Enrollment challenge scope differs from requested account/);
      assert.deepEqual(fixture.counters(), { signerCalls: 0, enrollCalls: 0, challengeCalls: 1 });
    }
  });

  test(`${profile}: accounts are chain independent and enrollment hashes remain chain bound`, async () => {
    const config = configFor(profile);
    const destination = { ...config, chainId: 8453 };
    const first = derive(config);
    const second = derive(destination);
    assert.notEqual(first.configHash, second.configHash);
    assert.deepEqual({ ...first, configHash: second.configHash }, second);
    const fixture = enrollmentFixture(destination, config);
    await assert.rejects(enrollCardanoAccount(fixture.options), /Enrollment challenge scope differs/);
    assert.deepEqual(fixture.counters(), { signerCalls: 0, enrollCalls: 0, challengeCalls: 1 });
  });

  test(`${profile}: enrollment message field order and chain commitment remain exact`, async () => {
    const challenge = await serviceFor(configFor(profile)).issue(address);
    const payload = JSON.parse(Buffer.from(challenge.payloadHex, 'hex').toString('utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload), ['domain', 'challenge', 'application', 'cardanoAddress', 'cardanoNetwork', 'baseChainId', 'configHash', 'issuedAt', 'expiresAt']);
    assert.equal(payload.domain, 'cardano-kernel:enrollment:v1');
    assert.equal(payload.baseChainId, 84532);
    assert.equal(payload.configHash, configHash(configFor(profile)));
    assert.notEqual(payload.configHash, configHash({ ...configFor(profile), chainId: 8453 }));
  });

  test(`${profile}: unsupported configuration fields fail before challenge services can be constructed`, () => {
    for (const value of [undefined, 'portable', null, '', 'unsupported', 0, false, {}, []]) {
      const base = configFor(profile);
      for (const config of [
        { ...base, addressDerivationMode: value },
        Object.assign(Object.create({ addressDerivationMode: value }), base),
        Object.defineProperty({ ...base }, 'addressDerivationMode', { value, enumerable: false }),
      ] as AccountConfig[]) {
        assert.throws(() => configHash(config), /Unsupported configuration field: addressDerivationMode/);
        assert.throws(() => derive(config), /Unsupported configuration field: addressDerivationMode/);
        assert.throws(() => serviceFor(config), /Unsupported configuration field: addressDerivationMode/);
      }
    }
  });

  test(`${profile}: positive safe chain IDs and complete configurations are required before enrollment`, async () => {
    for (const chainId of [undefined, null, NaN, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '84532']) {
      const config = { ...configFor(profile), chainId } as unknown as AccountConfig;
      assert.throws(() => configHash(config), /chain/);
      assert.throws(() => derive(config), /chain|identity input/);
      assert.throws(() => serviceFor(config), /chain/);
    }
    const backendConfig = configFor(profile);
    for (const change of [{ index: -1n }, { index: 1n << 256n }, { namespace: '0x00' }, { validatorCreationCode: '0x' }, { tableFactory: deployment(0) }]) {
      const config = { ...backendConfig, ...change } as AccountConfig;
      assert.throws(() => configHash(config));
      assert.throws(() => derive(config));
      assert.throws(() => serviceFor(config));
      const fixture = enrollmentFixture(config, backendConfig);
      await assert.rejects(enrollCardanoAccount(fixture.options));
      assert.deepEqual(fixture.counters(), { signerCalls: 0, enrollCalls: 0, challengeCalls: 0 });
    }
  });
}
