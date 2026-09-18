import '../scripts/experiments/errors.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createPublicClient, http, encodeFunctionData, keccak256, parseEther, type Abi, type Address } from 'viem';
import { baseSepolia } from 'viem/chains';
import { entryPoint07Abi } from 'viem/account-abstraction';
import { accountFromVerifiedKey, accountPreparation, accountFactory, profileConfigHash, type ProfileIdentityConfig } from '../packages/sdk/src/index.js';
import { verifyCip8Signature, fromHex, toHex } from '../packages/wallet/src/index.js';
import { deriveBackendProfileIdentity } from '../packages/enrollment/src/index.js';
import { liveContext, artifacts, matchesRuntime, json, entryPoint } from '../scripts/lib/live-context.js';
import { profileConfigFromCapture, readProfileManifest } from '../scripts/lib/identity-manifest.js';

const { values } = parseArgs({ options: { enrollment: { type: 'string' }, manifest: { type: 'string' }, profile: { type: 'string', default: 'general' }, infrastructure: { type: 'string' }, journal: { type: 'string' }, 'key-file': { type: 'string' }, 'key-variable': { type: 'string', default: 'SUBMITTER_PRIVATE_KEY' }, deposit: { type: 'string', default: '0' }, balance: { type: 'string', default: '0' }, 'funding-id': { type: 'string', default: 'initial' }, send: { type: 'boolean', default: false } } });
assert.ok(values.enrollment, 'Use --enrollment=path/to/reference-enrollment.json');
assert.ok(values.manifest, 'Use --manifest=path/to/current-profile-manifest.json');
assert.ok(!values.send || (values['key-file'] && values.infrastructure && values.journal), '--send requires an operator-owned submitter key, --infrastructure and --journal');
const capture = JSON.parse(readFileSync(values.enrollment, 'utf8')), challenge = capture.challenge;
assert.equal(capture.kind, 'reference-application-enrollment');
const config: ProfileIdentityConfig = profileConfigFromCapture(capture.sdkAccount.config);
const manifest = readProfileManifest(values.manifest);
assert.ok(manifest.profiles[values.profile!], 'Profile is missing from the supplied manifest');
assert.deepEqual(config, manifest.profiles[values.profile!].config, 'Enrollment configuration differs from the supplied manifest');
assert.equal(config.chainId, 84532); assert.equal(config.entryPoint.toLowerCase(), entryPoint.toLowerCase());
assert.equal(challenge.configHash, profileConfigHash(config));
const payload = JSON.stringify({ domain: 'cardano-kernel:enrollment:v1', challenge: challenge.id, application: challenge.application, cardanoAddress: challenge.cardanoAddress, cardanoNetwork: challenge.cardanoNetwork, baseChainId: challenge.baseChainId, configHash: challenge.configHash, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt });
assert.equal(challenge.payloadHex, toHex(new TextEncoder().encode(payload)));
assert.equal(challenge.baseChainId, 84532);
// Recheck the supplied enrollment before preparing or funding its identity.
// Enrollment consent does not authorize an account operation.
const verified = verifyCip8Signature(capture.signed, { address: challenge.cardanoAddress, network: challenge.cardanoNetwork, payload: fromHex(challenge.payloadHex) });
const account = accountFromVerifiedKey(verified, config);
assert.equal(account.identity.account.toLowerCase(), capture.sdkAccount.identity.account.toLowerCase());
const independent = deriveBackendProfileIdentity(account.publicKey, account.identity.protectedHeaders, config);
assert.equal(independent.account.toLowerCase(), account.identity.account.toLowerCase());
assert.equal(independent.preparationData, accountPreparation(account).data);
const client = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org') });
assert.equal(await client.getChainId(), 84532);
const find = artifacts(), abi = (name: string) => find(name).abi as Abi;
assert.equal(config.validatorCreationCode, `0x${find('PreparedTableValidator').evm.bytecode.object}`);
assert.equal(config.profileFactoryCreationCode, `0x${find('ProfileAccountFactory').evm.bytecode.object}`);
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
assert.equal(keccak256((await client.getCode({ address: config.kernelImplementation }))!), versions.baseSepolia.upstreamAddresses.kernelImplementation.runtimeCodeHash);
if (config.profile === 'restricted') assert.equal(keccak256((await client.getCode({ address: config.policy }))!), config.policyCodeHash);
const read = (address: Address, name: string, functionName: string, args: readonly unknown[] = []) => client.readContract({ address, abi: abi(name), functionName, args });
for (const [address, name] of [[config.tableFactory, 'PreparedTableFactory'], [config.profilePreparationFactory, 'ProfilePreparationFactory']] as const) {
  const code = await client.getCode({ address }); assert.ok(code && matchesRuntime(code, find(name)), 'Preparation infrastructure differs from the build');
}
assert.equal(String(await read(config.tableFactory, 'PreparedTableFactory', 'entryPoint')).toLowerCase(), entryPoint.toLowerCase());
assert.equal(String(await read(config.profilePreparationFactory, 'ProfilePreparationFactory', 'implementation')).toLowerCase(), config.kernelImplementation.toLowerCase());
assert.equal(String(await read(config.profilePreparationFactory, 'ProfilePreparationFactory', 'tableFactory')).toLowerCase(), config.tableFactory.toLowerCase());
const minimumDeposit = parseEther(values.deposit!), minimumBalance = parseEther(values.balance!);
assert.ok(minimumDeposit >= 0n && minimumDeposit <= parseEther('0.001') && minimumBalance >= 0n && minimumBalance <= parseEther('0.001'));
const factory = accountFactory(account), preparation = accountPreparation(account);
const factoryCode = await client.getCode({ address: factory });
const alreadyPrepared = Boolean(factoryCode && factoryCode !== '0x');
async function checkPreparedIdentity() {
  const code = await client.getCode({ address: factory });
  assert.ok(code && matchesRuntime(code, find('ProfileAccountFactory')));
  assert.equal(String(await read(factory, 'ProfileAccountFactory', 'getAddress', [config.namespace, config.index])).toLowerCase(), account.identity.account.toLowerCase());
  for (const [name, expected] of [['implementation', config.kernelImplementation], ['entryPoint', config.entryPoint], ['validator', account.identity.validator], ['hook', independent.hook]]) assert.equal(String(await read(factory, 'ProfileAccountFactory', name!)).toLowerCase(), expected!.toLowerCase());
}
if (alreadyPrepared) await checkPreparedIdentity();
const deposit = await client.readContract({ address: entryPoint, abi: entryPoint07Abi, functionName: 'balanceOf', args: [account.identity.account] });
const balance = await client.getBalance({ address: account.identity.account });
const intents = [
  ...(!alreadyPrepared ? [{ kind: 'prepare', ...preparation }] : []),
  ...(deposit < minimumDeposit ? [{ kind: 'gas-deposit', to: entryPoint, data: encodeFunctionData({ abi: entryPoint07Abi, functionName: 'depositTo', args: [account.identity.account] }), value: minimumDeposit - deposit }] : []),
  ...(balance < minimumBalance ? [{ kind: 'native-balance', to: account.identity.account, data: '0x' as const, value: minimumBalance - balance }] : []),
];
console.log(json({ mode: values.send ? 'send-test-preparation-and-funding' : 'unsigned-plan', account: account.identity.account, publicKey: account.publicKey, profile: account.profile, policy: config.policy, policyConfig: config.policyConfig, factory, intents, noOperationAuthorizationCreated: true }));
if (values.send && intents.length) {
  const live = await liveContext(values['key-file']!, values['key-variable']!, { manifest: values.infrastructure!, journal: values.journal!, independentSubmitter: true });
  try {
    for (const { kind, ...intent } of intents) {
      await live.transact(`example:${values['funding-id']}:${kind}:${account.identity.account}:${keccak256(intent.data)}`, intent, true);
      if (kind === 'prepare') await checkPreparedIdentity();
    }
  } finally { live.release(); }
}
if (alreadyPrepared || values.send) {
  await checkPreparedIdentity();
  console.log(json({ preparedIdentityChecked: true, account: account.identity.account }));
}
