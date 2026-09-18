import './errors.js';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createPublicClient, createWalletClient, http, encodeFunctionData, encodeAbiParameters, keccak256, parseEther, stringToHex, concatHex, toHex, zeroAddress, getCreateAddress, getContractAddress, type Abi, type Address, type Hex } from 'viem';
import { foundry } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { entryPoint07Abi } from 'viem/account-abstraction';
import { ed25519 } from '@noble/curves/ed25519.js';
import { encodeCalls, packOperation, operationHash, operationPayload, operationFromJson, operationToJson, validatorSignature, kernelProxyInitCode, type Operation, type Call } from '../../packages/protocol/src/index.js';
import { createDirectAdapter, httpRpc } from '../../packages/submission/src/index.js';
import { fixtureAddress, fixturePublicKey, signFixture } from '../../tests/fixtures.js';
import { fromHex, toHex as rawHex, verifyCip8Signature } from '../../packages/wallet/src/index.js';
import { artifacts, json } from '../lib/live-context.js';
import { createProfileEnrollmentService, createEnrollmentHandler, MemoryChallengeStore } from '../../packages/enrollment/src/index.js';
import { enrollCardanoAccount, httpEnrollmentTransport, signOperation, accountFactory, accountPreparation, type CardanoAccount, type ProfileIdentity, type ProfileIdentityConfig } from '../../packages/sdk/src/index.js';
import type { CardanoWalletAdapter } from '../../packages/wallet/src/index.js';

// Generated Cardano test key and Anvil's public test submitter ONLY.
const url = process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8545';
const client = createPublicClient({ chain: foundry, transport: http(url), pollingInterval: 50 });
assert.equal(await client.getChainId(), 31337);
const submitter = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const wallet = createWalletClient({ chain: foundry, transport: http(url), account: submitter });
const find = artifacts(); const deployments: Record<string, unknown> = {};
const abi = (name: string) => find(name).abi as Abi;
async function transaction(hash: Hex) {
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', `Transaction ${hash}`); return receipt;
}
async function deploy(name: string, args: readonly unknown[] = []): Promise<Address> {
  const a = name === 'EntryPoint' ? JSON.parse(readFileSync('vendor/entrypoint-v07/artifacts/EntryPoint.json', 'utf8')) : find(name);
  const receipt = await transaction(await wallet.deployContract({ abi: a.abi as Abi, bytecode: name === 'EntryPoint' ? a.bytecode : `0x${a.evm.bytecode.object}`, args, gas: 15000000n }));
  assert.ok(receipt.contractAddress);
  deployments[name] = { address: receipt.contractAddress, transactionHash: receipt.transactionHash, gasUsed: receipt.gasUsed };
  return receipt.contractAddress;
}
async function read(address: Address, name: string, functionName: string, args: readonly unknown[] = []) {
  return client.readContract({ address, abi: abi(name), functionName, args });
}
const ep = await deploy('EntryPoint'); const implementation = await deploy('Kernel', [ep]);
const tableFactory = await deploy('PreparedTableFactory', [ep]);
const prepFactory = await deploy('ProfilePreparationFactory', [implementation, tableFactory]);
const counter = await deploy('ExperimentCounter'); const adversary = await deploy('PolicyAdversary');
const targetPolicy = await deploy('TargetAllowlistPolicy'); const selectorPolicy = await deploy('SelectorAllowlistPolicy');
const recipient: Address = '0x0000000000000000000000000000000000001234';
const other: Address = '0x0000000000000000000000000000000000005678';
const fixtureAddr = fixtureAddress(14);
const verified = verifyCip8Signature(signFixture(new Uint8Array(32), fixtureAddr, undefined, true), { address: rawHex(fixtureAddr), network: 0, payload: new Uint8Array(32) });
const cardanoWallet: CardanoWalletAdapter = { name: 'GENERATED TEST FIXTURE', network: async () => 0, addresses: async () => [rawHex(fixtureAddr)], signData: async (address, payload) => { assert.equal(address, rawHex(fixtureAddr)); return signFixture(payload, fixtureAddr, undefined, true); } };
assert.equal(verified.protectedHeaders.length, 74);
const keyArgs = [toHex(fixturePublicKey), ed25519.Point.fromBytes(fixturePublicKey).toAffine().x, toHex(verified.protectedHeaders)] as const;
const increment = (n: bigint): Call => ({ target: counter, value: 0n, data: encodeFunctionData({ abi: abi('ExperimentCounter'), functionName: 'increment', args: [n] }) });
const sortedTargets = [counter, adversary, recipient].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
const targetConfig = encodeAbiParameters([{ type: 'address[]' }], [sortedTargets]);
const ruleType = [{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'selectors', type: 'bytes4[]' }, { name: 'allowEmpty', type: 'bool' }, { name: 'allowValue', type: 'bool' }] }] as const;
const selectorConfig = encodeAbiParameters(ruleType, [[
  { target: counter, selectors: [increment(1n).data.slice(0, 10) as Hex], allowEmpty: false, allowValue: false },
  { target: adversary, selectors: [encodeFunctionData({ abi: abi('PolicyAdversary'), functionName: 'reenter', args: [counter, '0x'] }).slice(0, 10) as Hex], allowEmpty: false, allowValue: false },
  { target: recipient, selectors: [], allowEmpty: true, allowValue: true },
].sort((a, b) => a.target.toLowerCase().localeCompare(b.target.toLowerCase()))]);
const prefund = parseEther('0.1');
const direct = createDirectAdapter({ rpc: httpRpc(url), submitter: submitter.address, sendTransaction: (intent) => wallet.sendTransaction({ ...intent, gas: 3000000n }) });
const userOpSelector = encodeFunctionData({ abi: abi('Kernel'), functionName: 'executeUserOp', args: [packOperation({ sender: counter, nonce: 0n, callData: '0x', callGasLimit: 0n, verificationGasLimit: 0n, preVerificationGas: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, signature: '0x' }), toHex(0n, { size: 32 })] }).slice(0, 10) as Hex;
const wrap = (data: Hex) => concatHex([userOpSelector, data]);
interface Profile { name: string; factory: Address; sender: Address; validator: Address; hook: Address; restricted: boolean; factoryData: Hex; account: CardanoAccount }
function sign(op: Operation): Operation {
  const payload = operationPayload(op, 31337, ep);
  const sig = verifyCip8Signature(signFixture(fromHex(payload), fixtureAddr, undefined, true), { address: rawHex(fixtureAddr), network: 0, payload: fromHex(payload) });
  return { ...op, signature: validatorSignature(sig) };
}
const nonce = (p: Profile) => client.readContract({ address: ep, abi: entryPoint07Abi, functionName: 'getNonce', args: [p.sender, 0n] });
async function operation(p: Profile, data: Hex, deploy = false) {
  return sign({ sender: p.sender, nonce: await nonce(p), callData: data, ...(deploy ? { factory: p.factory, factoryData: p.factoryData } : {}), callGasLimit: 600000n, verificationGasLimit: 500000n, preVerificationGas: 100000n, maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n, signature: '0x' });
}
function frames(t: any): any[] { return [t, ...(t.calls ?? []).flatMap(frames)]; }
const results: unknown[] = []; const preparations: unknown[] = []; const negatives: unknown[] = [];
async function execute(p: Profile, name: string, data: Hex, deploy = false, success = true) {
  const op = await operation(p, data, deploy);
  if (success) assert.deepEqual((await signOperation(p.account, op, cardanoWallet)).operation, operationFromJson(operationToJson(op)), 'SDK/wallet and raw protocol authorization agree');
  const context = { chainId: 31337, entryPoint: ep, operation: op };
  const submission = await direct.submit(context); assert.ok(submission.transactionHash);
  const receipt = await transaction(submission.transactionHash);
  const inclusion = await direct.status(context, submission);
  assert.equal(inclusion.status, success ? 'included' : 'execution-reverted', `${p.name}: ${name}`);
  const trace = await (client.request as (request: any) => Promise<any>)({ method: 'debug_traceTransaction', params: [submission.transactionHash, { tracer: 'callTracer' }] });
  const all = frames(trace);
  const maxGas = (address: Address) => all.filter((f) => f.to?.toLowerCase() === address.toLowerCase()).reduce((max, f) => BigInt(f.gasUsed) > max ? BigInt(f.gasUsed) : max, 0n);
  if (!success) {
    const hookFrames = all.filter((f) => f.to?.toLowerCase() === p.hook.toLowerCase());
    assert.ok(hookFrames.some((f) => f.error), `Expected actual policy/structural rejection: ${name}`);
    assert.ok(all.some((f) => f.to?.toLowerCase() === p.validator.toLowerCase() && f.output === toHex(0n, { size: 32 })), 'Cardano authorization must have succeeded before policy rejection');
  }
  const record = { profile: p.name, name, transactionHash: receipt.transactionHash, userOperationHash: operationHash(op, 31337, ep), status: inclusion.status, totalGas: receipt.gasUsed, actualGasUsed: inclusion.actualGasUsed, validatorGas: maxGas(p.validator), factoryGas: deploy ? maxGas(p.factory) : 0n, hookGas: p.restricted ? maxGas(p.hook) : 0n };
  (success ? results : negatives).push(record); return { op, receipt, inclusion };
}
const profiles: Profile[] = [];
for (const [name, policy, config] of [['general', zeroAddress, '0x'], ['targets', targetPolicy, targetConfig], ['selectors', selectorPolicy, selectorConfig]] as const) {
  const codeHash = policy === zeroAddress ? toHex(0n, { size: 32 }) : keccak256((await client.getCode({ address: policy }))!);
  const args = [...keyArgs, policy, config, codeHash] as const;
  const namespace = keccak256(stringToHex('generated local restricted profile acceptance'));
  const sdkConfig: ProfileIdentityConfig = { profile: name === 'general' ? 'general' : 'restricted', chainId: 31337, entryPoint: ep, kernelImplementation: implementation, tableFactory, profilePreparationFactory: prepFactory, validatorCreationCode: `0x${find('PreparedTableValidator').evm.bytecode.object}`, profileFactoryCreationCode: `0x${find('ProfileAccountFactory').evm.bytecode.object}`, namespace, index: 0n, policy, policyConfig: config, policyCodeHash: codeHash };
  const application = 'http://127.0.0.1:4173';
  const handler = createEnrollmentHandler(createProfileEnrollmentService({ application, config: sdkConfig, cardanoNetwork: 0, store: new MemoryChallengeStore() }));
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init))) as typeof fetch;
  const options = { wallet: cardanoWallet, application, config: sdkConfig, cardanoAddress: rawHex(fixtureAddr), cardanoNetwork: 0 as const, credential: 'stake' as const, transport: httpEnrollmentTransport(`${application}/`, fetcher) };
  const account = await enrollCardanoAccount(options); assert.deepEqual((await enrollCardanoAccount(options)).identity, account.identity);
  const predictedFactory = await read(prepFactory, 'ProfilePreparationFactory', 'getAddress', args) as Address;
  assert.equal(accountFactory(account).toLowerCase(), predictedFactory.toLowerCase());
  assert.equal(accountPreparation(account).data, encodeFunctionData({ abi: abi('ProfilePreparationFactory'), functionName: 'prepare', args }).toLowerCase());
  const initCode = await read(prepFactory, 'ProfilePreparationFactory', 'initCode', args) as Hex;
  const independentFactory = getContractAddress({ from: prepFactory, opcode: 'CREATE2', salt: keccak256(stringToHex('cardano-kernel:profile-preparation:v1')), bytecode: initCode });
  assert.equal(independentFactory.toLowerCase(), predictedFactory.toLowerCase());
  const prepared = await transaction(await wallet.writeContract({ address: prepFactory, abi: abi('ProfilePreparationFactory'), functionName: 'prepare', args, gas: 15000000n }));
  preparations.push({ profile: name, factory: predictedFactory, gasUsed: prepared.gasUsed, transactionHash: prepared.transactionHash });
  assert.equal((await read(prepFactory, 'ProfilePreparationFactory', 'getAddress', args) as Address).toLowerCase(), predictedFactory.toLowerCase());
  const sender = await read(predictedFactory, 'ProfileAccountFactory', 'getAddress', [namespace, 0n]) as Address;
  const validator = await read(predictedFactory, 'ProfileAccountFactory', 'validator') as Address;
  const hook = await read(predictedFactory, 'ProfileAccountFactory', 'hook') as Address;
  const initializeData = await read(predictedFactory, 'ProfileAccountFactory', 'initializeData') as Hex;
  assert.equal(account.identity.account.toLowerCase(), sender.toLowerCase());
  assert.equal(account.identity.initializeData, initializeData.toLowerCase());
  assert.equal((account.identity as ProfileIdentity).hook.toLowerCase(), hook.toLowerCase());
  assert.equal((account.identity as ProfileIdentity).profileHash, await read(predictedFactory, 'ProfileAccountFactory', 'profileHash'));
  const salt = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }], [keccak256(stringToHex('cardano-kernel:profile-account:v1')), namespace, 0n]));
  assert.equal((await read(predictedFactory, 'ProfileAccountFactory', 'accountSalt', [namespace, 0n])), salt);
  for (const [boundaryNamespace, boundaryIndex] of [[toHex(0n, { size: 32 }), 0n], [toHex((1n << 256n) - 1n, { size: 32 }), (1n << 256n) - 1n], [namespace, 1n]] as const) {
    const boundarySalt = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }], [keccak256(stringToHex('cardano-kernel:profile-account:v1')), boundaryNamespace, boundaryIndex]));
    assert.equal(await read(predictedFactory, 'ProfileAccountFactory', 'accountSalt', [boundaryNamespace, boundaryIndex]), boundarySalt, `${name}: ABI namespace/index boundaries`);
    const boundaryAddress = getContractAddress({ from: predictedFactory, opcode: 'CREATE2', salt: keccak256(concatHex([initializeData, boundarySalt])), bytecode: kernelProxyInitCode(implementation) });
    assert.equal((await read(predictedFactory, 'ProfileAccountFactory', 'getAddress', [boundaryNamespace, boundaryIndex]) as Address).toLowerCase(), boundaryAddress.toLowerCase());
  }
  const prediction = getContractAddress({ from: predictedFactory, opcode: 'CREATE2', salt: keccak256(concatHex([initializeData, salt])), bytecode: kernelProxyInitCode(implementation) });
  assert.equal(prediction.toLowerCase(), sender.toLowerCase());
  if (name !== 'general') assert.equal(hook.toLowerCase(), getCreateAddress({ from: predictedFactory, nonce: 1n }).toLowerCase());
  const p: Profile = { name, factory: predictedFactory, sender, validator, hook, restricted: name !== 'general', factoryData: encodeFunctionData({ abi: abi('ProfileAccountFactory'), functionName: 'createAccount', args: [namespace, 0n] }), account };
  profiles.push(p);
  await transaction(await wallet.writeContract({ address: ep, abi: entryPoint07Abi, functionName: 'depositTo', args: [sender], value: prefund }));
  await transaction(await wallet.sendTransaction({ to: sender, value: 100000n }));
  const data = (calls: Call[]) => p.restricted ? wrap(encodeCalls(calls)) : encodeCalls(calls);
  await execute(p, 'deployment-and-call', data([increment(1n)]), true);
  await execute(p, 'subsequent-call', data([increment(1n)]));
  await execute(p, 'batch', data([increment(2n), increment(3n)]));
  await execute(p, 'native-transfer', data([{ target: recipient, value: 123n, data: '0x' }]));
  assert.equal(await client.getBalance({ address: sender }), 100000n - 123n);
  assert.equal(await read(sender, 'Kernel', 'rootValidator'), concatHex(['0x01', validator]).toLowerCase());
  const vc = await read(sender, 'Kernel', 'validationConfig', [concatHex(['0x01', validator])]) as { nonce: number; hook: Address };
  assert.equal(vc.hook.toLowerCase(), (p.restricted ? hook : '0x0000000000000000000000000000000000000001').toLowerCase());
  assert.equal(await read(validator, 'PreparedTableValidator', 'publicKey'), toHex(fixturePublicKey));
  if (!p.restricted) {
    await execute(p, 'general-root-self-administration', encodeFunctionData({ abi: abi('Kernel'), functionName: 'grantAccess', args: [concatHex(['0x01', validator]), '0xdeadbeef', true] }));
    assert.equal(await read(sender, 'Kernel', 'isAllowedSelector', [concatHex(['0x01', validator]), '0xdeadbeef']), true);
    continue;
  }
  await assert.rejects(client.simulateContract({ address: prepFactory, abi: abi('ProfilePreparationFactory'), functionName: 'prepare', args: [...keyArgs, policy, config, toHex(0n, { size: 32 })], account: submitter }), /Policy code mismatch/);
  negatives.push({ profile: name, name: 'preparation-policy-code-hash-mismatch', rejectedBeforeAccountCreation: true });
  const kernelCall = (functionName: string, args: readonly unknown[]) => encodeFunctionData({ abi: abi('Kernel'), functionName, args });
  const admin: [string, Hex][] = [
    ['upgrade', kernelCall('upgradeTo', [adversary])],
    ['root-replacement', kernelCall('changeRootValidator', [concatHex(['0x01', adversary]), zeroAddress, '0x', '0x'])],
    ...[1, 2, 3, 4, 5, 6].map((type): [string, Hex] => [`install-module-${type}`, kernelCall('installModule', [BigInt(type), adversary, '0x'])]),
    ['remove-hook', kernelCall('uninstallModule', [4n, hook, '0x'])],
    ['uninstall-validator', kernelCall('uninstallValidation', [concatHex(['0x01', validator]), '0x', '0x'])],
    ['grant-selector', kernelCall('grantAccess', [concatHex(['0x01', validator]), '0xdeadbeef', true])],
    ['install-validations', kernelCall('installValidations', [[], [], [], []])],
    ['nonce-invalidation', kernelCall('invalidateNonce', [2])],
    ['reinitialize', initializeData],
  ];
  const badExecutions: [string, Hex][] = [
    ...admin.map(([label, data]): [string, Hex] => [label, wrap(data)]),
    ['self-call', wrap(encodeCalls([{ target: sender, value: 0n, data: admin[0]![1] }]))],
    ['self-call-in-batch', wrap(encodeCalls([increment(9n), { target: sender, value: 0n, data: admin[0]![1] }]))],
    ['disallowed-target', wrap(encodeCalls([{ target: other, value: 1n, data: '0x' }]))],
    ['disallowed-batch', wrap(encodeCalls([increment(9n), { target: other, value: 1n, data: '0x' }]))],
    ['zero-target', wrap(encodeCalls([{ target: zeroAddress, value: 1n, data: '0x' }]))],
    ['delegatecall', wrap(kernelCall('execute', [`0xff${'00'.repeat(31)}`, concatHex([adversary, '0x'])]))],
    ['try-mode', wrap(kernelCall('execute', [`0x0001${'00'.repeat(30)}`, concatHex([counter, toHex(0n, { size: 32 }), increment(1n).data])]))],
    ['trailing-outer-bytes', wrap(concatHex([encodeCalls([increment(1n)]), '0x00']))],
    ['nested-execute-user-op', wrap(wrap(encodeCalls([increment(1n)])))],
    ['fallback', wrap('0xdeadbeef')],
    ['executor', wrap(kernelCall('executeFromExecutor', [toHex(0n, { size: 32 }), concatHex([counter, toHex(0n, { size: 32 }), increment(1n).data])]))],
  ];
  if (name === 'selectors') badExecutions.push(
    ['wrong-selector', wrap(encodeCalls([{ target: counter, value: 0n, data: '0xdeadbeef' }]))],
    ['empty-calldata-not-enabled', wrap(encodeCalls([{ target: counter, value: 0n, data: '0x' }]))],
    ['short-calldata', wrap(encodeCalls([{ target: counter, value: 0n, data: '0x01' }]))],
    ['value-not-enabled', wrap(encodeCalls([{ ...increment(1n), value: 1n }]))],
  );
  const beforeCounter = await read(counter, 'ExperimentCounter', 'number');
  for (const [label, data] of badExecutions) {
    await execute(p, label, data, false, false);
    assert.equal(await read(counter, 'ExperimentCounter', 'number'), beforeCounter, label);
    assert.equal(await client.getBalance({ address: sender }), 100000n - 123n, label);
  }
  // Raw EntryPoint execution and administration cannot evade the mandatory hook.
  for (const [label, data] of [['raw-execute', encodeCalls([increment(1n)])], ...admin] as [string, Hex][]) {
    const op = await operation(p, data);
    await assert.rejects(client.simulateContract({ address: ep, abi: entryPoint07Abi, functionName: 'handleOps', args: [[packOperation(op)], submitter.address], account: submitter }), /AA23/);
    negatives.push({ profile: name, name: `without-hook-prefix:${label}`, rejectedDuringValidation: true });
  }
  for (const [label, key] of [
    ['uninstalled-validator', (1n << 176n) | (BigInt(adversary) << 16n)],
    ['uninstalled-permission', (2n << 176n) | (0xdeadbeefn << 144n)],
    ['enable-validator', (1n << 184n) | (1n << 176n) | (BigInt(adversary) << 16n)],
    ['unsupported-validation-type', 3n << 176n],
    ['submitter-key-as-root', 0n],
  ] as [string, bigint][]) {
    const alternateNonce = await client.readContract({ address: ep, abi: entryPoint07Abi, functionName: 'getNonce', args: [sender, key] });
    let op = sign({ ...await operation(p, wrap(encodeCalls([increment(1n)]))), nonce: alternateNonce });
    if (label === 'enable-validator') op = { ...op, signature: concatHex([zeroAddress, encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }], ['0x', '0x', '0xe9ae5c53', op.signature, op.signature])]) };
    if (label === 'submitter-key-as-root') op = { ...op, signature: await submitter.signMessage({ message: { raw: operationHash(op, 31337, ep) } }) };
    await assert.rejects(client.simulateContract({ address: ep, abi: entryPoint07Abi, functionName: 'handleOps', args: [[packOperation(op)], submitter.address], account: submitter }), /AA2[34]/);
    negatives.push({ profile: name, name: label, rejectedDuringValidation: true });
  }
  // Called contracts cannot use the account's administrative or executor entry paths.
  for (const [label, data] of [admin[0]!, ['execute', encodeCalls([increment(9n)])], ['executor', kernelCall('executeFromExecutor', [toHex(0n, { size: 32 }), '0x'])], ['fallback', '0xdeadbeef']] as [string, Hex][]) {
    await execute(p, `reject-reentry:${label}`, wrap(encodeCalls([{ target: adversary, value: 0n, data: encodeFunctionData({ abi: abi('PolicyAdversary'), functionName: 'reenter', args: [sender, data] }) }])));
  }
  for (const type of [1, 2, 3]) assert.equal(await read(sender, 'Kernel', 'isModuleInstalled', [BigInt(type), adversary, type === 3 ? '0xdeadbeef' : '0x']), false);
  assert.equal(await read(sender, 'Kernel', 'rootValidator'), concatHex(['0x01', validator]).toLowerCase());
  assert.equal((await read(sender, 'Kernel', 'validationConfig', [concatHex(['0x01', validator])]) as { hook: Address }).hook.toLowerCase(), hook.toLowerCase());
  const slot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
  assert.equal(await client.getStorageAt({ address: sender, slot }), `0x${'0'.repeat(24)}${implementation.slice(2).toLowerCase()}`);
  await execute(p, 'still-restricted-after-bypass-attempts', wrap(encodeCalls([increment(1n)])));
}
// Distinct prepared profiles retain distinct accounts in portable derivation.
assert.equal(new Set(profiles.map((p) => p.sender.toLowerCase())).size, profiles.length);
const output = { kind: 'local-profile-policy-full-kernel-path', timestamp: new Date().toISOString(), chainId: 31337, realWallet: false, baseSepolia: false, publicBundlerAdmission: false, privateBundler: false, fixture: 'generated Ed25519 test key and CIP-8 reward-address headers', verificationGasLimit: '500000', authority: { general: 'Cardano root administration enabled', restricted: 'immutable CALL policy; no administration, alternate modules or opt-out' }, deployments, preparations, profiles, results, negatives };
const evidenceFile = process.env.POLICY_EVIDENCE_FILE ?? 'evidence/local/policies.json';
mkdirSync(dirname(evidenceFile), { recursive: true }); writeFileSync(evidenceFile, json(output));
console.log(json({ status: 'local-pass', evidence: evidenceFile, profiles: profiles.length, successfulOperations: results.length, rejectedAttempts: negatives.length, preparations }));
