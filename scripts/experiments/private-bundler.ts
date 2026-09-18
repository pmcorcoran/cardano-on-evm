import './errors.js';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { createPublicClient, createWalletClient, http, encodeFunctionData, encodeErrorResult, decodeFunctionResult, parseEther, keccak256, concatHex, type Abi, type Address, type Hex } from 'viem';
import { foundry } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { entryPoint07Abi } from 'viem/account-abstraction';
import { createProfileEnrollmentService, createEnrollmentHandler, MemoryChallengeStore } from '../../packages/enrollment/src/index.js';
import { enrollCardanoAccount, constructOperation, signOperation, httpEnrollmentTransport, type CardanoAccount, type ProfileIdentityConfig } from '../../packages/sdk/src/index.js';
import { createPrivateBundlerAdapter, httpRpc, rpcOperation, inclusionFromReceipt, type Inclusion, type OperationContext, type Submission } from '../../packages/submission/src/index.js';
import { fixtureAddress, signFixture } from '../../tests/fixtures.js';
import { operationHash, packOperation, type ProfileIdentity } from '../../packages/protocol/src/index.js';
import { toHex as rawHex, type CardanoWalletAdapter } from '../../packages/wallet/src/index.js';
import { artifacts, json, matchesRuntime } from '../lib/live-context.js';

// Only this optional experiment imports the separately installed service.
const serviceModule = '../../infra/bundler/src/service.mjs';
const { startService } = await import(serviceModule);
const { values } = parseArgs({ options: { 'source-worker': { type: 'boolean', default: false }, 'basic-validation': { type: 'boolean', default: false }, 'policy-fixture': { type: 'string' }, out: { type: 'string' }, 'config-out': { type: 'string' } } });
assert.ok(values['policy-fixture'] && values.out && values['config-out'], 'Supply --policy-fixture, --out and --config-out for this fresh local run');
const sourceWorker = values['source-worker'];
const gatewayPort = Number(process.env.LOCAL_BUNDLER_GATEWAY_PORT ?? '4387');
const workerPort = Number(process.env.LOCAL_BUNDLER_WORKER_PORT ?? '4388');
for (const port of [gatewayPort, workerPort]) assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Invalid local bundler port');
assert.notEqual(gatewayPort, workerPort);
const evidenceFile = values.out;
const fixture = JSON.parse(readFileSync(values['policy-fixture'], 'utf8'));
assert.equal(fixture.chainId, 31337); assert.equal(fixture.realWallet, false);
const url = process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8545';
const client = createPublicClient({ chain: foundry, transport: http(url), pollingInterval: 100 });
assert.equal(await client.getChainId(), 31337);
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const wallet = createWalletClient({ chain: foundry, transport: http(url), account });
const ep = fixture.deployments.EntryPoint.address as Address;
const counter = fixture.deployments.ExperimentCounter.address as Address;
assert.ok(await client.getCode({ address: ep }), 'Run experiment:policies against this Anvil first');
const find = artifacts(); const abi = (name: string) => find(name).abi as Abi;
const output: any = { kind: 'local-private-bundler-acceptance', timestamp: new Date().toISOString(), chainId: 31337, realWallet: false, baseSepolia: false, entryPoint: ep, source: 'infra/bundler/upstream.json', simulations: [], operations: [], negatives: [], lifecycle: 'pending' };
mkdirSync(dirname(evidenceFile), { recursive: true }); mkdirSync(dirname(values['config-out']), { recursive: true });
const save = () => writeFileSync(evidenceFile, json(output));
async function transaction(hash: Hex) { const receipt = await client.waitForTransactionReceipt({ hash }); assert.equal(receipt.status, 'success'); return receipt; }
const config = JSON.parse(readFileSync('infra/bundler/config/base-sepolia.example.json', 'utf8'));
config.workerBuild = sourceWorker ? 'source' : 'package';
output.workerBuild = config.workerBuild;
config.chainId = 31337; config.entryPoint = ep; config.entryPointCodeHash = keccak256((await client.getCode({ address: ep }))!);
config.gateway.port = gatewayPort; config.worker.port = workerPort; config.gateway.requestsPerMinute = 1000;
config.worker['chain-type'] = 'default'; config.worker['block-time'] = 1000;
config.worker['ceiling-max-fee-per-gas'] = '10'; config.worker['ceiling-max-priority-fee-per-gas'] = '2';
config.worker['static-max-priority-fee-per-gas'] = '1';
config.limits.maxFeePerGas = '10000000000'; config.limits.maxOperationCostWei = '20000000000000000';
config.policy.rules[0].target = counter;
const generatedAddress = fixtureAddress(14);
const cardano: CardanoWalletAdapter = { name: 'GENERATED PRIVATE-SERVICE FIXTURE', network: async () => 0, addresses: async () => [rawHex(generatedAddress)], signData: async (address, payload) => { assert.equal(address, rawHex(generatedAddress)); return signFixture(payload, generatedAddress, undefined, true); } };
const rpc = httpRpc(url);
try {
  const result = await rpc('debug_traceCall', [{ to: ep, data: '0x' }, 'latest', { tracer: '{step:function(){},fault:function(){},result:function(){return {customTracer:true}}}' }]) as any;
  assert.equal(result.customTracer, true);
  output.customTracer = { supported: true };
} catch (error) {
  output.customTracer = { supported: false, reason: error instanceof Error ? error.message.slice(0, 400) : 'Unavailable' };
  config.worker['safe-mode'] = false;
  config.admissionDeviationReason = 'This Anvil RPC rejects the custom JavaScript validation tracer. Alto basic validation still simulates EntryPoint and verifies the Cardano signature; ERC-7562 opcode/storage admission is not enforced by this local configuration.';
}
if (values['basic-validation']) {
  config.worker['safe-mode'] = false;
  config.admissionDeviationReason = 'Explicit local basic-validation acceptance: EntryPoint/Cardano authorization simulation remains active; ERC-7562 opcode/storage parser behavior is covered separately by generated regression inputs. This run does not establish strict end-to-end execution.';
}
for (const [path, flag] of [['EntryPointSimulations.sol/EntryPointSimulations07', 'entrypoint-simulation-contract-v7'], ['PimlicoSimulations.sol/PimlicoSimulations', 'pimlico-simulation-contract']]) {
  const sourcePin = JSON.parse(readFileSync('infra/bundler/upstream.json', 'utf8'));
  const artifactRoot = sourceWorker ? `infra/bundler/.local/alto-${sourcePin.commit}/src/esm/contracts` : 'infra/bundler/node_modules/@pimlico/alto/esm/contracts';
  const a = JSON.parse(readFileSync(`${artifactRoot}/${path}.json`, 'utf8'));
  const receipt = await transaction(await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, gas: 10000000n }));
  const code = await client.getCode({ address: receipt.contractAddress! });
  config.worker[flag!] = receipt.contractAddress;
  output.simulations.push({ artifact: path, address: receipt.contractAddress, transactionHash: receipt.transactionHash, creationCodeHash: keccak256(a.bytecode.object), runtimeCodeHash: keccak256(code!), gasUsed: receipt.gasUsed });
}
const configPath = values['config-out'];
writeFileSync(configPath, json(config)); output.config = config; save();
// Second public Anvil development key avoids sharing the deployer's nonce.
const token = 'local-generated-test-token-000000000000000000000';
const env = { BASE_SEPOLIA_RPC_URL: url, BUNDLER_AUTH_TOKEN: token, BUNDLER_EXECUTOR_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' };
const statePath = evidenceFile.replace(/\.json$/, '') + '-service-lifecycle.json';
const service = await startService({ configPath, env, statePath, log: (event: unknown) => { output.serviceLogs ??= []; output.serviceLogs.push(event); save(); console.log(JSON.stringify(event)); } });
const privateRpc = httpRpc(`http://127.0.0.1:${gatewayPort}/rpc`, { headers: { authorization: `Bearer ${token}` }, timeoutMs: 55000 });
const adapter = createPrivateBundlerAdapter(privateRpc);
const increment = (by: bigint) => ({ target: counter, value: 0n, data: encodeFunctionData({ abi: abi('ExperimentCounter'), functionName: 'increment', args: [by] }) });
const nonce = (a: CardanoAccount) => client.readContract({ address: ep, abi: entryPoint07Abi, functionName: 'getNonce', args: [a.identity.account, 0n] });
const counterValue = () => client.readContract({ address: counter, abi: abi('ExperimentCounter'), functionName: 'number' }) as Promise<bigint>;
async function signed(a: CardanoAccount, calls = [increment(1n)], deploy = false) {
  const unsigned = constructOperation(a, { calls, nonce: await nonce(a), deploy, gas: { verificationGasLimit: 500000n, callGasLimit: 600000n, preVerificationGas: 100000n }, fees: { maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n } });
  return (await signOperation(a, unsigned, cardano)).operation;
}
async function waitInclusion(context: OperationContext, submission: Submission) {
  let included: Inclusion = await adapter.status(context, submission);
  for (let tries = 0; included.status === 'pending' && tries < 40; tries++) { await new Promise((resolve) => setTimeout(resolve, 500)); included = await adapter.status(context, submission); }
  return included;
}
async function submit(a: CardanoAccount, name: string, deploy = false, calls = [increment(1n)]) {
  const operation = await signed(a, calls, deploy), context = { chainId: 31337, entryPoint: ep, operation };
  const before = await counterValue();
  output.lastAttempt = { name, context }; save();
  const submission = await adapter.submit(context);
  const included = await waitInclusion(context, submission);
  assert.equal(included.status, 'included');
  const receipt = await client.getTransactionReceipt({ hash: included.transactionHash! });
  assert.equal(inclusionFromReceipt(context, receipt).status, 'included');
  assert.equal(await nonce(a), operation.nonce + 1n);
  assert.equal(await counterValue() - before, deploy || calls.length === 1 ? 1n : 5n);
  assert.equal(await client.readContract({ address: operation.sender, abi: abi('Kernel'), functionName: 'rootValidator' }), concatHex(['0x01', a.identity.validator]).toLowerCase());
  const result = { name, profile: a.profile, sender: operation.sender, nonce: operation.nonce, submission, inclusion: included, totalGas: receipt.gasUsed, independentReceiptChecked: true };
  output.operations.push(result); save(); console.log(json({ kind: 'private-operation-passed', name, sender: operation.sender, transactionHash: receipt.transactionHash, gas: receipt.gasUsed }));
}
try {
  const profiles: CardanoAccount[] = [];
  for (const profile of fixture.profiles) {
    const sdkConfig: ProfileIdentityConfig = { ...profile.account.config, index: sourceWorker ? 2n : 1n };
    const application = 'http://127.0.0.1:4173';
    const handler = createEnrollmentHandler(createProfileEnrollmentService({ application, config: sdkConfig, cardanoNetwork: 0, store: new MemoryChallengeStore() }));
    const fetcher = ((input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init))) as typeof fetch;
    const options = { wallet: cardano, application, config: sdkConfig, cardanoAddress: rawHex(generatedAddress), cardanoNetwork: 0 as const, credential: 'stake' as const, transport: httpEnrollmentTransport(`${application}/`, fetcher) };
    const enrolled = await enrollCardanoAccount(options);
    assert.deepEqual((await enrollCardanoAccount(options)).identity, enrolled.identity);
    profiles.push(enrolled);
    await transaction(await wallet.writeContract({ address: ep, abi: entryPoint07Abi, functionName: 'depositTo', args: [enrolled.identity.account], value: parseEther('0.1') }));
    await submit(enrolled, `${profile.name}-deploy`, true);
    await submit(enrolled, `${profile.name}-later`);
    await submit(enrolled, `${profile.name}-batch`, false, [increment(2n), increment(3n)]);
  }
  const admission = structuredClone(config.policy);
  const allFrames = (frame: any): any[] => [frame, ...(frame.calls ?? []).flatMap(allFrames)];
  for (const [index, restricted] of profiles.entries()) {
    if (restricted.profile !== 'restricted') continue;
    const profile = fixture.profiles[index].name, identity = restricted.identity as ProfileIdentity;
    const policyConfig = restricted.config as ProfileIdentityConfig;
    const prohibited = await signed(restricted, [{ target: account.address, value: 0n, data: '0x' }]);
    const context = { chainId: 31337, entryPoint: ep, operation: prohibited };
    const snapshot = async () => ({
      nonce: await nonce(restricted), counter: await counterValue(), balance: await client.getBalance({ address: identity.account }),
      deposit: await client.readContract({ address: ep, abi: entryPoint07Abi, functionName: 'balanceOf', args: [identity.account] }),
      accountCode: await client.getCode({ address: identity.account }), hookCode: await client.getCode({ address: identity.hook }),
      root: await client.readContract({ address: identity.account, abi: abi('Kernel'), functionName: 'rootValidator' }),
      configuration: await client.readContract({ address: identity.hook, abi: abi('RestrictedExecutionHook'), functionName: 'configuration' }),
      hookEntryPoint: await client.readContract({ address: identity.hook, abi: abi('RestrictedExecutionHook'), functionName: 'entryPoint' }),
      hookPolicy: await client.readContract({ address: identity.hook, abi: abi('RestrictedExecutionHook'), functionName: 'policy' }),
      hookPolicyCodeHash: await client.readContract({ address: identity.hook, abi: abi('RestrictedExecutionHook'), functionName: 'policyCodeHash' }),
      hookConfigHash: await client.readContract({ address: identity.hook, abi: abi('RestrictedExecutionHook'), functionName: 'configHash' }),
      policyCode: await client.getCode({ address: policyConfig.policy }),
    });
    const before = await snapshot();
    assert.ok(matchesRuntime(before.hookCode!, find('RestrictedExecutionHook')));
    assert.equal(before.configuration, policyConfig.policyConfig);
    assert.equal(keccak256(before.policyCode!), policyConfig.policyCodeHash);
    assert.equal(String(before.hookEntryPoint).toLowerCase(), ep.toLowerCase());
    assert.equal(String(before.hookPolicy).toLowerCase(), policyConfig.policy.toLowerCase());
    assert.equal(before.hookPolicyCodeHash, policyConfig.policyCodeHash);
    assert.equal(before.hookConfigHash, keccak256(policyConfig.policyConfig));
    config.policy = structuredClone(admission); writeFileSync(configPath, json(config)); await service.reload();
    await assert.rejects(adapter.submit(context), /denied by admission/);
    output.negatives.push({ profile, name: 'app-admission-denied-target', rejected: true });
    config.policy = { kind: 'open', revision: `replace-with-open-${profile}`, paymasters: [] };
    writeFileSync(configPath, json(config)); await service.reload();
    // Change a signature scalar byte while retaining canonical ABI/header data.
    const invalid = { ...prohibited, signature: `${prohibited.signature.slice(0, 130)}${(parseInt(prohibited.signature.slice(130, 132), 16) ^ 1).toString(16).padStart(2, '0')}${prohibited.signature.slice(132)}` as Hex };
    await assert.rejects(adapter.submit({ ...context, operation: invalid }), /signature|AA24|validation/i);
    assert.equal(await nonce(restricted), before.nonce);
    const hash = operationHash(prohibited, 31337, ep);
    for (const [candidate, expected] of [[prohibited, 0n], [invalid, 1n]] as const) {
      const data = encodeFunctionData({ abi: abi('PreparedTableValidator'), functionName: 'validateUserOp', args: [packOperation(candidate), hash] });
      const result = await rpc('eth_call', [{ from: identity.account, to: identity.validator, data }, 'latest']) as Hex;
      assert.equal(decodeFunctionResult({ abi: abi('PreparedTableValidator'), functionName: 'validateUserOp', data: result }), expected);
    }
    output.negatives.push({ profile, name: 'permissive-admission-cannot-accept-invalid-Cardano-signature', rejected: true, deployedValidatorAcceptedOriginalAndRejectedCorruption: true });
    // A valid signature reaches the immutable hook, which rejects execution.
    const rejectedSubmission = await adapter.submit(context);
    const rejectedInclusion = await waitInclusion(context, rejectedSubmission);
    assert.equal(rejectedInclusion.status, 'execution-reverted');
    const rejectedReceipt = await client.getTransactionReceipt({ hash: rejectedInclusion.transactionHash! });
    const checked = inclusionFromReceipt(context, rejectedReceipt);
    assert.equal(checked.status, 'execution-reverted');
    const after = await snapshot();
    assert.equal(after.nonce, before.nonce + 1n); assert.equal(after.counter, before.counter);
    assert.equal(before.deposit - after.deposit, checked.actualGasCost);
    for (const field of ['balance', 'accountCode', 'hookCode', 'root', 'configuration', 'hookEntryPoint', 'hookPolicy', 'hookPolicyCodeHash', 'hookConfigHash', 'policyCode'] as const) assert.equal(after[field], before[field]);
    const trace = await rpc('debug_traceTransaction', [rejectedReceipt.transactionHash, { tracer: 'callTracer' }]);
    const frames = allFrames(trace).filter((frame) => frame.from?.toLowerCase() === identity.account.toLowerCase());
    assert.ok(!frames.some((frame) => frame.type === 'CALL' && frame.to?.toLowerCase() === account.address.toLowerCase()), 'Prohibited target was called');
    const validatorFrame = frames.find((frame) => frame.to?.toLowerCase() === identity.validator.toLowerCase() && frame.input?.startsWith('0x97003203'));
    assert.ok(validatorFrame && !validatorFrame.error); assert.equal(BigInt(validatorFrame.output), 0n);
    const hookFrame = frames.find((frame) => frame.to?.toLowerCase() === identity.hook.toLowerCase() && frame.error);
    assert.ok(hookFrame); assert.equal(hookFrame.output, encodeErrorResult({ abi: abi('RestrictedExecutionHook'), errorName: 'RestrictedExecution' }));
    output.negatives.push({ profile, name: 'permissive-admission-cannot-bypass-onchain-restriction', sameSignedOperation: true, executionReverted: true, nonceConsumedAndGasCharged: true, immutableAccountAndPolicyUnchanged: true, validatorAcceptedGeneratedSignature: true, hookRejectedBeforeProhibitedCall: true, inclusion: rejectedInclusion, before, after, trace }); save();
    const valid = await signed(restricted);
    output.estimates ??= [];
    output.estimates.push({ profile, result: await privateRpc('eth_estimateUserOperationGas', [rpcOperation(valid), ep]) });
    await submit(restricted, `${profile}-after-admission-reconfiguration`);
  }
  output.status = 'local-pass';
} finally {
  await service.stop();
  await assert.rejects(fetch(`http://127.0.0.1:${gatewayPort}/health`, { signal: AbortSignal.timeout(2000) }));
  await assert.rejects(fetch(`http://127.0.0.1:${workerPort}`, { signal: AbortSignal.timeout(2000) }));
  output.lifecycle = { started: true, stopped: true, gatewayAndWorkerPortsClosed: true, file: statePath }; save();
}
console.log(json({ status: output.status, operations: output.operations.length, negatives: output.negatives.length, safeMode: config.worker['safe-mode'], evidence: evidenceFile }));
