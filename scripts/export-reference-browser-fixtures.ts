import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { encodeFunctionData, keccak256, stringToHex, zeroAddress, zeroHash, type Address, type Hex } from 'viem';
import { createProfileEnrollmentService, MemoryChallengeStore } from '../packages/enrollment/src/index.js';
import { accountFromVerifiedKey, constructOperation, encodeTargetAllowlist, encodeSelectorAllowlist, operationHash, operationPayload, operationToJson, type ProfileIdentityConfig, type ProfileIdentity, type TableIdentityConfig } from '../packages/sdk/src/index.js';
import { fixtureAddress, signFixture } from '../tests/fixtures.js';
import { fromHex, toHex, verifyCip8Signature } from '../packages/wallet/src/index.js';
import { addressArtifactSet, bindAddressArtifacts, creationBytecode } from './lib/address-artifacts.js';
import { checkLiveRequest, type LiveRequest } from './lib/live-request.js';
import { entryPoint, json } from './lib/live-context.js';

// Public deterministic TEST data. These addresses describe an undeployed,
// unfunded loopback fixture with Base Sepolia's chain shape, not a network run.
const artifacts = addressArtifactSet();
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const counter = address(32), recipient = address(33);
const common = { chainId: 84532, entryPoint, kernelImplementation: address(16), tableFactory: address(17), validatorCreationCode: creationBytecode(artifacts.find('PreparedTableValidator')), namespace: keccak256(stringToHex('cardano-kernel:generated-browser-fixture:v1')), index: 0n };
const application = process.env.REFERENCE_APP_URL ?? 'http://127.0.0.1:4174';
const fixtures: any = { kind: 'generated-loopback-browser-fixtures', testData: true, realWallet: false, infrastructureDeployed: false, application, address: toHex(fixtureAddress(14)), profiles: {} };
const manifest: any = { kind: 'generated-loopback-profile-manifest', testData: true, provenance: 'Public test wallet and synthetic addresses; loopback use only; no deployment or public-chain acceptance.', addressDerivationMode: 'portable', artifactIdentity: artifacts.identity, chainId: 84532, infrastructureVerified: false, profiles: {} };
const increment = encodeFunctionData({ abi: artifacts.find('ExperimentCounter').abi, functionName: 'increment', args: [1n] });
const verified = verifyCip8Signature(signFixture(new Uint8Array(32), fixtureAddress(14), undefined, true), { address: fixtures.address, network: 0, payload: new Uint8Array(32) });
mkdirSync('.local/review-requests', { recursive: true });
function review(name: string, config: ProfileIdentityConfig | TableIdentityConfig) {
  const account = accountFromVerifiedKey(verified, config);
  const operation = constructOperation(account, { calls: [{ target: counter, value: 0n, data: increment }], nonce: 0n, deploy: true, gas: { verificationGasLimit: 500000n, callGasLimit: 250000n, preVerificationGas: 100000n }, fees: { maxFeePerGas: 50000000n, maxPriorityFeePerGas: 2000000n } });
  const id = createHash('sha256').update(`generated-loopback-review:${name}`).digest('hex');
  const identity = account.identity as ProfileIdentity;
  const request: LiveRequest & { testData: true } = { version: 1, testData: true, id, createdAt: '2026-01-01T00:00:00.000Z', title: `GENERATED TEST: ${name} increment(1)`, mode: 'direct', chainId: 84532, entryPoint, cardanoAddress: fixtures.address, cardanoNetwork: 0, credential: 'stake', publicKey: account.publicKey, protectedHeaderHash: account.protectedHeaderHash, userOperationHash: operationHash(operation, 84532, entryPoint), payloadHex: operationPayload(operation, 84532, entryPoint), operation: operationToJson(operation), profile: account.profile, validator: identity.validator, sourceCapture: 'generated public test wallet; no wallet capture', ...('profile' in config ? { profileDetails: { name: name as 'general' | 'targets' | 'selectors', factory: identity.profileFactory, hook: identity.hook, policy: config.policy, policyConfig: config.policyConfig, policyCodeHash: config.policyCodeHash, profileHash: identity.profileHash } } : {}) };
  checkLiveRequest(request);
  writeFileSync(`.local/review-requests/${id}.json`, json(request));
}
for (const name of ['general', 'targets', 'selectors'] as const) {
  const policy = name === 'general' ? zeroAddress : address(name === 'targets' ? 19 : 20);
  const policyConfig = name === 'general' ? '0x' : name === 'targets' ? encodeTargetAllowlist([counter, recipient]) : encodeSelectorAllowlist([{ target: counter, selectors: [increment.slice(0, 10) as Hex], allowEmpty: false, allowValue: false }, { target: recipient, selectors: [], allowEmpty: true, allowValue: true }]);
  const policyCodeHash = name === 'general' ? zeroHash : keccak256(`0x${artifacts.find(name === 'targets' ? 'TargetAllowlistPolicy' : 'SelectorAllowlistPolicy').evm.deployedBytecode.object}`);
  const config: ProfileIdentityConfig = { ...common, profile: name === 'general' ? 'general' : 'restricted', profilePreparationFactory: address(18), profileFactoryCreationCode: creationBytecode(artifacts.find('ProfileAccountFactory')), policy, policyConfig, policyCodeHash };
  manifest.profiles[name] = { config, artifactBinding: bindAddressArtifacts(config), counter, permittedRecipient: recipient };
  const service = createProfileEnrollmentService({ application, cardanoNetwork: 0, config, store: new MemoryChallengeStore(), ttlMs: 900000 });
  const challenge = await service.issue(fixtures.address), signed = signFixture(fromHex(challenge.payloadHex), fixtureAddress(14), undefined, true);
  const enrolled = await service.enroll(challenge.id, signed);
  fixtures.profiles[name] = { config, challenge, signed, enrolled: { ...enrolled, sessionId: `mock-${name}`, enrollmentFile: `GENERATED-TEST/${name}.json` } };
  review(name, config);
}
review('experimental-general', { ...common, kernelFactory: address(21) });
const bundle = await build({ stdin: { contents: `import { fixtureAddress, signFixture } from './tests/fixtures.ts'; import { fromHex, toHex } from './packages/wallet/src/index.ts';
window.testSignCalls = [];
window.walletMocks = {};
window.cardano = {};
for (const id of ['lace', 'eternl']) {
  const state = window.walletMocks[id] = { network: 0, rewards: [toHex(fixtureAddress(14))], payments: [toHex(fixtureAddress(0)), toHex(fixtureAddress(6))], enableCalls: 0, signCalls: [], pause: null, resume: null, enableError: null, signError: null, addressError: null };
  const wait = async (method) => { if (state.pause === method) { state.pause = null; await new Promise(resolve => { state.resume = () => { state.resume = null; resolve(); }; }); } };
  window.cardano[id] = { name: 'GENERATED ' + id.toUpperCase() + ' TEST PROVIDER', apiVersion: '1', enable: async () => {
    state.enableCalls++; await wait('enable'); if (state.enableError) throw state.enableError;
    return { getNetworkId: async () => state.network,
      getRewardAddresses: async () => { await wait('addresses'); if (state.addressError) throw state.addressError; return state.rewards; },
      getChangeAddress: async () => { await wait('addresses'); if (state.addressError) throw state.addressError; return state.payments[0]; },
      getUsedAddresses: async () => state.payments,
      signData: async (address, payload) => { const call = {address, payload}; state.signCalls.push(call); window.testSignCalls.push(call); await wait('sign'); if (state.signError) throw state.signError; return signFixture(fromHex(payload), fromHex(address), undefined, true); },
    };
  } };
}
`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022' });
writeFileSync('.local/reference-profile-manifest.json', json(manifest));
writeFileSync('.local/reference-browser-fixtures.json', json(fixtures));
writeFileSync('.local/reference-browser-wallet.js', bundle.outputFiles[0]!.contents);
console.log('Generated loopback manifest, browser wallet and four review requests; no wallet or chain operation occurred.');
