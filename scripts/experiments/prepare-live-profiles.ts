import './errors.js';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { keccak256, type Abi, type Address } from 'viem';
import { accountFromVerifiedKey, accountPreparation, type ProfileIdentity } from '../../packages/sdk/src/index.js';
import { deriveBackendProfileIdentity } from '../../packages/enrollment/src/index.js';
import { readProfileManifest } from '../lib/identity-manifest.js';
import { liveContext, json, matchesRuntime, assertLiveConfig } from '../lib/live-context.js';
import { readWalletCapture } from '../lib/wallet-capture.js';

const { values } = parseArgs({ options: { manifest: { type: 'string' }, capture: { type: 'string' }, infrastructure: { type: 'string' }, journal: { type: 'string' }, out: { type: 'string' }, 'key-file': { type: 'string' }, 'key-variable': { type: 'string', default: 'SUBMITTER_PRIVATE_KEY' }, send: { type: 'boolean', default: false } } });
for (const field of ['manifest', 'capture', 'infrastructure', 'journal', 'out', 'key-file'] as const) assert.ok(values[field], `--${field} is required`);
const manifest = readProfileManifest(values.manifest!);
assert.equal(manifest.chainId, 84532);
assert.equal(manifest.infrastructureVerified, true, 'Deploy and verify the supplied infrastructure first');
assert.ok(!manifest.testData, 'Generated loopback fixtures cannot prepare public infrastructure');
const { enrollment: verified, challenge, sha256: captureSha256 } = readWalletCapture(values.capture!);
assert.equal(challenge.baseChainId, manifest.chainId, 'Capture and manifest chains differ');
const state: any = existsSync(values.out!) ? readProfileManifest(values.out!) : { ...manifest, profiles: {}, kind: 'prepared-profile-manifest', createdAt: new Date().toISOString() };
assert.equal(state.chainId, manifest.chainId); assert.deepEqual(state.artifactIdentity, manifest.artifactIdentity);
const context = await liveContext(values['key-file']!, values['key-variable']!, { manifest: values.infrastructure!, journal: values.journal!, independentSubmitter: true });
try {
  const { client, find, transact, tableFactory } = context;
  for (const [name, item] of Object.entries(manifest.profiles) as [string, any][]) {
    assertLiveConfig(item.config, context);
    assert.equal(item.counter.toLowerCase(), context.counter.toLowerCase(), 'Profile counter differs from checked infrastructure');
    const account = accountFromVerifiedKey(verified, item.config), identity = account.identity as ProfileIdentity;
    const backendIdentity = deriveBackendProfileIdentity(account.publicKey, identity.protectedHeaders, item.config);
    assert.equal(json(identity).toLowerCase(), json(backendIdentity).toLowerCase());
    if (state.profiles[name]) assert.equal(json(state.profiles[name].identity).toLowerCase(), json(identity).toLowerCase(), 'Previously prepared identity changed');
    const receipt = await transact(`prepare-profile-${identity.profileFactory.toLowerCase()}`, accountPreparation(account), values.send);
    if (!receipt) continue;
    const read = (address: Address, contract: string, fn: string) => client.readContract({ address, abi: find(contract).abi as Abi, functionName: fn, blockNumber: receipt.blockNumber });
    assert.ok(matchesRuntime((await client.getCode({ address: identity.profileFactory, blockNumber: receipt.blockNumber }))!, find('ProfileAccountFactory')));
    for (const [fn, expected] of [['implementation', item.config.kernelImplementation], ['entryPoint', item.config.entryPoint], ['validator', identity.validator], ['hook', identity.hook], ['profileHash', identity.profileHash], ['initializeData', identity.initializeData]]) assert.equal(String(await read(identity.profileFactory, 'ProfileAccountFactory', fn!)).toLowerCase(), String(expected).toLowerCase(), `Factory immutable ${fn}`);
    const prediction = await client.readContract({ address: identity.profileFactory, abi: find('ProfileAccountFactory').abi as Abi, functionName: 'getAddress', args: [item.config.namespace, item.config.index], blockNumber: receipt.blockNumber });
    assert.equal(String(prediction).toLowerCase(), identity.account.toLowerCase());
    assert.ok(matchesRuntime((await client.getCode({ address: identity.validator, blockNumber: receipt.blockNumber }))!, find('PreparedTableValidator')));
    for (const [fn, expected] of [['entryPoint', item.config.entryPoint], ['publicKey', account.publicKey], ['protectedHeaderHash', account.protectedHeaderHash]]) assert.equal(String(await read(identity.validator, 'PreparedTableValidator', fn!)).toLowerCase(), String(expected).toLowerCase());
    if (account.profile === 'restricted') {
      assert.ok(matchesRuntime((await client.getCode({ address: identity.hook, blockNumber: receipt.blockNumber }))!, find('RestrictedExecutionHook')));
      for (const [fn, expected] of [['entryPoint', item.config.entryPoint], ['policy', item.config.policy], ['policyCodeHash', item.config.policyCodeHash], ['configHash', keccak256(item.config.policyConfig)], ['configuration', item.config.policyConfig]]) assert.equal(String(await read(identity.hook, 'RestrictedExecutionHook', fn!)).toLowerCase(), String(expected).toLowerCase());
    }
    state.profiles[name] = { ...item, identity, backendIdentity, publicKey: account.publicKey, cardanoAddress: account.cardanoAddress, sourceCapture: values.capture, sourceCaptureSha256: captureSha256, sdkBackendAndLiveFactoryAgree: true, factoryRuntimeAndEveryImmutableChecked: true, hookRuntimeAndConfigurationChecked: account.profile === 'restricted', preparedTransactionHash: receipt.transactionHash };
    mkdirSync(dirname(values.out!), { recursive: true }); writeFileSync(values.out!, json(state));
    console.log(json({ profile: name, account: identity.account, factory: identity.profileFactory, output: values.out }));
  }
} finally { context.release(); }
