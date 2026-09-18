import { createPublicClient, createWalletClient, http, encodeFunctionData, encodeAbiParameters, parseEther, toHex, concatHex, keccak256, stringToHex, decodeEventLog, type Abi, type Hex, type Address } from 'viem';
import './errors.js';
import { privateKeyToAccount } from 'viem/accounts';
import { entryPoint07Abi, getUserOperationHash } from 'viem/account-abstraction';
import { foundry } from 'viem/chains';
import { ed25519 } from '@noble/curves/ed25519.js';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { compileContracts } from '../build-contracts.js';
import { fixtureAddress, fixturePublicKey, signFixture } from '../../tests/fixtures.js';
import { verifyCip8Signature, toHex as rawHex, fromHex } from '../../packages/wallet/src/index.js';
import assert from 'node:assert/strict';

const url = process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8545';
const client = createPublicClient({ chain: foundry, transport: http(url) });
assert.equal(await client.getChainId(), 31337);
const submitter = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const wallet = createWalletClient({ chain: foundry, transport: http(url), account: submitter });
const artifacts: ReturnType<typeof compileContracts> = process.argv.includes('--reuse-build')
  ? JSON.parse(readFileSync('artifacts/contracts.json', 'utf8')) : compileContracts();
const preparedKey = process.argv.includes('--prepared');
const tableKey = process.argv.includes('--table');
const laceHeaders = process.argv.includes('--lace-headers');
const profileGas = process.argv.includes('--profile-gas');
const verificationGasLimit = preparedKey && !profileGas ? 500_000n : 1_500_000n;
const reward = process.argv.includes('--reward');
const depositPrefund = process.argv.includes('--deposit-prefund');
const fixtureAddr = fixtureAddress(reward ? 14 : laceHeaders ? 0 : 6);
const signedFixture = (payload: Uint8Array) => signFixture(payload, fixtureAddr, undefined, laceHeaders);
const evidenceName = `${tableKey ? 'table-key' : preparedKey ? 'prepared-key' : 'kernel-path'}${laceHeaders ? '-lace-headers' : ''}${reward ? '-reward' : ''}${depositPrefund ? '-deposit' : ''}${profileGas ? '-profile' : ''}`;
const artifact = (name: string) => {
  const matches = Object.values(artifacts).flatMap((a) => Object.entries(a)).filter(([n]) => n === name);
  assert.equal(matches.length, 1, `Unique artifact ${name}`); return matches[0]![1];
};
const deploymentGas: Record<string, string> = {};
async function deploy(name: string, args: readonly unknown[] = []): Promise<Address> {
  const a = artifact(name); assert.equal(Object.keys(a.evm.bytecode.linkReferences).length, 0, 'Experiment uses internal libraries');
  const hash = await wallet.deployContract({ abi: a.abi as Abi, bytecode: `0x${a.evm.bytecode.object}`, args });
  const receipt = await client.waitForTransactionReceipt({ hash }); assert.equal(receipt.status, 'success');
  deploymentGas[name] = receipt.gasUsed.toString(); return receipt.contractAddress!;
}
const epArtifact = JSON.parse(readFileSync('vendor/entrypoint-v07/artifacts/EntryPoint.json', 'utf8'));
const epDeploy = await wallet.deployContract({ abi: entryPoint07Abi, bytecode: epArtifact.bytecode });
const epReceipt = await client.waitForTransactionReceipt({ hash: epDeploy });
assert.equal(epReceipt.status, 'success'); const entryPoint = epReceipt.contractAddress!;
deploymentGas.EntryPoint = epReceipt.gasUsed.toString();
const kernel = await deploy('Kernel', [entryPoint]);
const factory = await deploy('KernelFactory', [kernel]);
const fixture = verifyCip8Signature(signedFixture(new Uint8Array(32)), { address: rawHex(fixtureAddr), network: 0, payload: new Uint8Array(32) });
const validatorName = tableKey ? 'PreparedTableValidator' : preparedKey ? 'PreparedKeyValidator' : 'KernelPathValidator';
const keyArgs = [toHex(fixturePublicKey), ed25519.Point.fromBytes(fixturePublicKey).toAffine().x, toHex(fixture.protectedHeaders)] as const;
const validator = await deploy(validatorName, preparedKey ? [entryPoint, ...keyArgs] : [entryPoint]);
const counter = await deploy('ExperimentCounter');
const kernelAbi = artifact('Kernel').abi as Abi; const factoryAbi = artifact('KernelFactory').abi as Abi;
const validatorAbi = artifact(validatorName).abi as Abi; const counterAbi = artifact('ExperimentCounter').abi as Abi;
const validatorData = preparedKey ? '0x' : encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes' }], keyArgs);
const initData = encodeFunctionData({ abi: kernelAbi, functionName: 'initialize', args: [concatHex(['0x01', validator]), '0x0000000000000000000000000000000000000000', validatorData, '0x', []] });
const salt = toHex(1n, { size: 32 });
const sender = await client.readContract({ address: factory, abi: factoryAbi, functionName: 'getAddress', args: [initData, salt] }) as Address;
const createData = encodeFunctionData({ abi: factoryAbi, functionName: 'createAccount', args: [initData, salt] });
const fundHash = depositPrefund
  ? await wallet.writeContract({ address: entryPoint, abi: entryPoint07Abi, functionName: 'depositTo', args: [sender], value: parseEther('0.1') })
  : await wallet.sendTransaction({ to: sender, value: parseEther('0.1') });
const fundingReceipt = await client.waitForTransactionReceipt({ hash: fundHash });
const call = (amount: bigint) => encodeFunctionData({ abi: counterAbi, functionName: 'increment', args: [amount] });
function executeData(batch: boolean): Hex {
  const execution = batch
    ? encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'callData', type: 'bytes' }] }], [[{ target: counter, value: 0n, callData: call(2n) }, { target: counter, value: 0n, callData: call(3n) }]])
    : concatHex([counter, toHex(0n, { size: 32 }), call(1n)]);
  return encodeFunctionData({ abi: kernelAbi, functionName: 'execute', args: [batch ? concatHex(['0x01', toHex(0n, { size: 31 })]) : toHex(0n, { size: 32 }), execution] });
}
function operation(nonce: bigint, first: boolean, batch = false) {
  return {
    sender, nonce, callData: executeData(batch),
    ...(first ? { factory, factoryData: createData } : {}),
    callGasLimit: 250_000n, verificationGasLimit,
    preVerificationGas: 100_000n, maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n, signature: '0x' as Hex,
  };
}
function packed(op: ReturnType<typeof operation>) {
  return {
    sender: op.sender, nonce: op.nonce, initCode: op.factory ? concatHex([op.factory, op.factoryData!]) : '0x' as Hex,
    callData: op.callData, accountGasLimits: concatHex([toHex(op.verificationGasLimit, { size: 16 }), toHex(op.callGasLimit, { size: 16 })]),
    preVerificationGas: op.preVerificationGas, gasFees: concatHex([toHex(op.maxPriorityFeePerGas, { size: 16 }), toHex(op.maxFeePerGas, { size: 16 })]),
    paymasterAndData: '0x' as Hex, signature: op.signature,
  };
}
function sign(op: ReturnType<typeof operation>, chainId = 31337, ep = entryPoint, alternateSeed?: Uint8Array): void {
  const hash = getUserOperationHash({ userOperation: op, entryPointAddress: ep, entryPointVersion: '0.7', chainId });
  const payload = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [keccak256(stringToHex('cardano-kernel:operation:v1')), hash]));
  const verified = verifyCip8Signature(signedFixture(fromHex(payload)), { address: rawHex(fixtureAddr), network: 0, payload: fromHex(payload) });
  const signature = alternateSeed ? ed25519.sign(verified.signStructure, alternateSeed) : verified.signature;
  op.signature = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes32' }, { type: 'bytes32' }], [toHex(verified.protectedHeaders), toHex(signature.slice(0, 32)), toHex(signature.slice(32))]);
}
interface Trace { to?: Address; gasUsed?: Hex; input?: Hex; calls?: Trace[] }
function sumCalls(trace: Trace, to: Address): bigint {
  // Do not double count descendants when their parent already matches.
  if (trace.to?.toLowerCase() === to.toLowerCase()) return BigInt(trace.gasUsed ?? '0x0');
  return (trace.calls ?? []).reduce((n, t) => n + sumCalls(t, to), 0n);
}
const results = [];
for (const [index, batch] of [false, false, true].entries()) {
  const op = operation(BigInt(index), index === 0, batch); sign(op);
  const hash = await client.readContract({ address: entryPoint, abi: entryPoint07Abi, functionName: 'getUserOpHash', args: [packed(op)] });
  assert.equal(hash, getUserOperationHash({ userOperation: op, entryPointAddress: entryPoint, entryPointVersion: '0.7', chainId: 31337 }));
  const tx = await wallet.writeContract({ address: entryPoint, abi: entryPoint07Abi, functionName: 'handleOps', args: [[packed(op)], submitter.address], gas: 3_000_000n });
  const receipt = await client.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== 'success') {
    let reason = 'handleOps reverted';
    try { await client.simulateContract({ address: entryPoint, abi: entryPoint07Abi, functionName: 'handleOps', args: [[packed(op)], submitter.address], account: submitter }); }
    catch (error) { reason = String(error).match(/AA\d\d [A-Za-z ]+/)?.[0] ?? reason; }
    const failure = { kind: 'failed-local-kernel-experiment', timestamp: new Date().toISOString(), chainId: 31337, preparedKey, laceHeaders, verificationGasLimit: verificationGasLimit.toString(), realWallet: false, baseSepolia: false, publicBundlerAdmission: false, transactionHash: tx, totalTransactionGas: receipt.gasUsed.toString(), reason, addresses: { entryPoint, kernel, factory, validator, sender, counter }, deploymentGas, precedingResults: results };
    mkdirSync('evidence/local', { recursive: true }); writeFileSync(`evidence/local/${evidenceName}-failure.json`, JSON.stringify(failure, null, 2) + '\n');
    console.log(JSON.stringify(failure, null, 2));
    assert.fail(reason);
  }
  const events = receipt.logs.flatMap((log) => { try { return [decodeEventLog({ abi: entryPoint07Abi, data: log.data, topics: log.topics })]; } catch { return []; } });
  const event = events.find((e) => e.eventName === 'UserOperationEvent');
  assert.ok(event && event.eventName === 'UserOperationEvent'); assert.equal(event.args.success, true);
  // Local Anvil debug call; no equivalent measurement is claimed for live Base.
  const trace = await (client.request as (request: unknown) => Promise<Trace>)({ method: 'debug_traceTransaction', params: [tx, { tracer: 'callTracer' }] });
  const validatorCalls: Trace[] = [];
  const walk = (t: Trace) => { if (t.to?.toLowerCase() === validator.toLowerCase()) validatorCalls.push(t); for (const c of t.calls ?? []) walk(c); }; walk(trace);
  const validationSelector = encodeFunctionData({ abi: validatorAbi, functionName: 'validateUserOp', args: [packed(op), hash] }).slice(0, 10);
  const validationGas = validatorCalls.filter((t) => t.input?.startsWith(validationSelector)).reduce((n, t) => n + BigInt(t.gasUsed ?? '0x0'), 0n);
  const factoryGas = sumCalls(trace, factory);
  assert.ok(validationGas > 0n);
  results.push({ kind: index === 0 ? 'deployment-and-call' : batch ? 'batch' : 'subsequent-call', transactionHash: tx, userOperationHash: hash, totalTransactionGas: receipt.gasUsed.toString(), entryPointActualGasUsed: event.args.actualGasUsed.toString(), validatorGas: validationGas.toString(), accountCreationFrameGas: factoryGas.toString(), success: true });
}
assert.equal(await client.readContract({ address: counter, abi: counterAbi, functionName: 'number' }), 7n);
const owner = await client.readContract({ address: validator, abi: validatorAbi, functionName: 'ownerOf', args: [sender] }) as { publicKey: Hex };
assert.equal(owner.publicKey, toHex(fixturePublicKey));
assert.equal(await client.getCode({ address: sender }) !== '0x', true);
const negativeResults = [];
const positiveControl = operation(3n, false); sign(positiveControl);
await client.simulateContract({ address: entryPoint, abi: entryPoint07Abi, functionName: 'handleOps', args: [[packed(positiveControl)], submitter.address], account: submitter });
for (const kind of ['altered-call', 'incorrect-key', 'wrong-chain', 'wrong-entrypoint', 'nonce-replay', 'kernel-replayable-prefix', 'enrollment-domain', 'invalid-encoding', 'trailing-encoding', 'cross-account'] as const) {
  const op = operation(kind === 'nonce-replay' ? 0n : 3n, false); sign(op);
  if (kind === 'altered-call') op.callData = executeData(true);
  if (kind === 'incorrect-key') sign(op, 31337, entryPoint, new Uint8Array(32).fill(77));
  if (kind === 'wrong-chain') sign(op, 84532);
  if (kind === 'wrong-entrypoint') sign(op, 31337, factory);
  if (kind === 'kernel-replayable-prefix') op.signature = concatHex(['0x0555ad2729e8da1777a4e5020806f8bf7601c3db6bfe402f410a34958363a95a', op.signature]);
  if (kind === 'enrollment-domain') {
    const enrollmentPayload = fromHex(stringToHex('cardano-kernel:enrollment:v1'));
    const enrolled = verifyCip8Signature(signedFixture(enrollmentPayload), { address: rawHex(fixtureAddr), network: 0, payload: enrollmentPayload });
    op.signature = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes32' }, { type: 'bytes32' }], [toHex(enrolled.protectedHeaders), toHex(enrolled.signature.slice(0, 32)), toHex(enrolled.signature.slice(32))]);
  }
  if (kind === 'invalid-encoding') op.signature = '0x1234';
  if (kind === 'trailing-encoding') op.signature = concatHex([op.signature, '0x00']);
  if (kind === 'cross-account') {
    const different = { ...op, sender: counter }; sign(different); op.signature = different.signature;
  }
  await assert.rejects(client.simulateContract({ address: entryPoint, abi: entryPoint07Abi, functionName: 'handleOps', args: [[packed(op)], submitter.address], account: submitter }), kind);
  negativeResults.push({ kind, rejected: true });
}
const evidence = { kind: 'local-full-entrypoint-kernel-path', timestamp: new Date().toISOString(), chainId: 31337, preparedKey, laceHeaders, reward, depositPrefund, fundingTransactionHash: fundHash, fundingGas: fundingReceipt.gasUsed.toString(), verificationGasLimit: verificationGasLimit.toString(), fixture: 'generated Ed25519 test seed; not Lace', protectedHeaderBytes: fixture.protectedHeaders.length, submission: 'normal RPC, funded local transaction submitter, EntryPoint.handleOps; no bundler service', realWallet: false, baseSepolia: false, publicBundlerAdmission: false, restrictedPolicies: false, addresses: { entryPoint, kernel, factory, validator, sender, counter }, ownerKeyChecked: true, predictionMatchedDeployment: true, deploymentGas, results, negativeResults };
mkdirSync('evidence/local', { recursive: true }); writeFileSync(`evidence/local/${evidenceName}.json`, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
