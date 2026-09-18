import './errors.js';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { parseArgs } from 'node:util';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createPublicClient, createWalletClient, defineChain, http, encodeDeployData, encodeFunctionData, decodeErrorResult, keccak256, parseEther, stringToHex, toHex, zeroAddress, zeroHash, concatHex, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { entryPoint07Abi } from 'viem/account-abstraction';
import { accountPreparation, accountFactory, constructOperation, enrollCardanoAccount, signOperation, operationHash, operationPayload, operationToJson, packOperation, kernelProxyInitCode, encodeTargetAllowlist, encodeSelectorAllowlist, type AccountConfig, type CardanoAccount, type ProfileIdentity } from '../../packages/sdk/src/index.js';
import { createProfileEnrollmentService, createTableEnrollmentService, MemoryChallengeStore, deriveBackendProfileIdentity, deriveBackendTableIdentity } from '../../packages/enrollment/src/index.js';
import { toHex as rawHex, type CardanoWalletAdapter } from '../../packages/wallet/src/index.js';
import { inclusionFromReceipt } from '../../packages/submission/src/index.js';
import { fixtureAddress, signFixture } from '../../tests/fixtures.js';
import { addressArtifactSet, bindAddressArtifacts, creationBytecode } from '../lib/address-artifacts.js';
import { matchesRuntime, json, verifyPreparedProfile } from '../lib/live-context.js';

const { values } = parseArgs({ options: { out: { type: 'string', default: '.local/address-two-chain' }, anvil: { type: 'string', default: process.env.ANVIL_BIN ?? '.local/tools/foundry/anvil' }, 'port-base': { type: 'string', default: '20630' } } });
const out = resolve(values.out!), anvil = resolve(values.anvil!), portBase = Number(values['port-base']);
assert.ok(Number.isInteger(portBase) && portBase >= 1024 && portBase < 65535);
assert.ok(!existsSync(out), 'Use a fresh evidence directory; prior runs are never overwritten');
mkdirSync(out, { recursive: true });
const chains = [31337, 31338] as const;
const children: ChildProcess[] = [], descriptors: number[] = [];
const submitter = privateKeyToAccount(generatePrivateKey());
const cardanoSeed = new Uint8Array(randomBytes(32)), publicKey = ed25519.getPublicKey(cardanoSeed), cardanoAddress = fixtureAddress(14, 0, publicKey);
const cardanoWallet: CardanoWalletAdapter = { name: 'EPHEMERAL LOCAL TEST WALLET', network: async () => 0, addresses: async () => [rawHex(cardanoAddress)], signData: async (address, payload) => { assert.equal(address, rawHex(cardanoAddress)); return signFixture(payload, cardanoAddress, cardanoSeed, true); } };
const report: any = { kind: 'two-fresh-chain-address-and-replay-acceptance', startedAt: new Date().toISOString(), allChecksPassed: false,
  chainIds: chains, ephemeralCredentials: true, publicTransactionsSent: 0, deployer: submitter.address,
  artifactIdentity: addressArtifactSet().identity, infrastructure: [], rows: [], replay: [] };
const save = () => writeFileSync(`${out}/matrix.json`, json(report));
const normalized = (value: unknown) => json(value).toLowerCase();
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const frames = (frame: any): any[] => [frame, ...(frame.calls ?? []).flatMap(frames)];
async function portAvailable(port: number) {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => server.close(() => done())); });
}
async function stop() {
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill('SIGTERM');
    for (let n = 0; n < 50 && child.exitCode === null && child.signalCode === null; n++) await sleep(100);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise<void>((done) => child.once('exit', () => done())); }
  }
  for (const fd of descriptors) closeSync(fd);
}
const onSignal = () => { void stop().then(() => { report.failure = 'Interrupted'; report.servicesStopped = true; save(); process.exit(1); }); };
process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);

async function start(chainId: number, port: number) {
  await portAvailable(port);
  const fd = openSync(`${out}/anvil-${chainId}.log`, 'wx'); descriptors.push(fd);
  const child = spawn(anvil, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(chainId), '--hardfork', 'cancun', '--silent'], { stdio: ['ignore', fd, fd] });
  children.push(child);
  const url = `http://127.0.0.1:${port}`;
  const chain = defineChain({ id: chainId, name: `Local acceptance ${chainId}`, nativeCurrency: { name: 'Local ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
  const client = createPublicClient({ chain, transport: http(url, { retryCount: 0, timeout: 30000 }), pollingInterval: 20 });
  const wallet = createWalletClient({ chain, transport: http(url), account: submitter });
  let ready = false;
  for (let n = 0; n < 100; n++) {
    assert.equal(child.exitCode, null, 'Anvil exited before readiness');
    try { if (await client.getChainId() === chainId) { ready = true; break; } } catch { /* bounded startup polling */ }
    await sleep(100);
  }
  assert.ok(ready, 'Fresh Anvil did not become ready');
  assert.equal(await client.getBlockNumber(), 0n, 'The regression requires a fresh, unforked chain');
  const rpc = (method: string, params: unknown[]) => (client.request as any)({ method, params });
  await rpc('anvil_setBalance', [submitter.address, toHex(parseEther('1000'))]);
  assert.equal(await client.getTransactionCount({ address: submitter.address }), 0);
  return { chainId, port, chain, client, wallet, rpc, deployments: {} as Record<string, any>, accounts: new Map<string, CardanoAccount>() };
}
type Local = Awaited<ReturnType<typeof start>>;
async function transaction(local: Local, hash: Hex, expected: 'success' | 'reverted' = 'success') {
  const receipt = await local.client.waitForTransactionReceipt({ hash }); assert.equal(receipt.status, expected); return receipt;
}
async function deploy(local: Local, label: string, name: string, args: readonly unknown[] = []) {
  const artifact = name === 'EntryPoint' ? JSON.parse(readFileSync('artifacts/entrypoint-reference.json', 'utf8')) : addressArtifactSet().find(name);
  const bytecode = name === 'EntryPoint' ? artifact.bytecode as Hex : creationBytecode(artifact);
  const data = encodeDeployData({ abi: artifact.abi as Abi, bytecode, args });
  const nonce = await local.client.getTransactionCount({ address: submitter.address });
  // Solady's pinned Kernel caches the deployment chain ID and EIP-712 separator
  // in runtime immutables. Give only its constructor the same local context on
  // both chains, then restore each real test chain ID before any preparation,
  // prediction, enrollment, account deployment or operation. No code is patched.
  const commonKernelContext = name === 'Kernel' && local.chainId !== chains[0];
  if (commonKernelContext) await local.rpc('anvil_setChainId', [chains[0]]);
  let receipt;
  try {
    const deploymentChain = commonKernelContext ? { ...local.chain, id: chains[0] } : local.chain;
    receipt = await transaction(local, await local.wallet.sendTransaction({ chain: deploymentChain, data, nonce, gas: 15000000n }));
  } finally { if (commonKernelContext) await local.rpc('anvil_setChainId', [local.chainId]); }
  assert.equal(await local.client.getChainId(), local.chainId);
  assert.ok(receipt.contractAddress);
  const code = await local.client.getCode({ address: receipt.contractAddress }); assert.ok(code);
  assert.ok(matchesRuntime(code, artifact), `${label}: deployed artifact template`);
  local.deployments[label] = { address: receipt.contractAddress, nonce, data, creationCodeHash: keccak256(bytecode), deployedCode: code, runtimeCodeHash: keccak256(code), transactionHash: receipt.transactionHash,
    constructorChainId: name === 'Kernel' ? chains[0] : local.chainId };
  return receipt.contractAddress;
}
async function setup(local: Local) {
  const ep = await deploy(local, 'EntryPoint', 'EntryPoint');
  const kernel = await deploy(local, 'Kernel', 'Kernel', [ep]);
  await deploy(local, 'KernelFactory', 'KernelFactory', [kernel]);
  const table = await deploy(local, 'PreparedTableFactory', 'PreparedTableFactory', [ep]);
  await deploy(local, 'ProfilePreparationFactory', 'ProfilePreparationFactory', [kernel, table]);
  await deploy(local, 'TargetAllowlistPolicy', 'TargetAllowlistPolicy');
  await deploy(local, 'SelectorAllowlistPolicy', 'SelectorAllowlistPolicy');
  await deploy(local, 'ExperimentCounter', 'ExperimentCounter');
  report.infrastructure.push({ chainId: local.chainId, startNonce: 0, deployments: local.deployments }); save();
}

const variants = ['general', 'targets', 'selectors', 'experimental-general'] as const;
async function prepareAndDeploy(local: Local, variant: typeof variants[number]) {
  const selected = addressArtifactSet(), find = selected.find, d = local.deployments;
  const address = (name: string) => d[name].address as Address;
  const common = { chainId: local.chainId, entryPoint: address('EntryPoint'), kernelImplementation: address('Kernel'), tableFactory: address('PreparedTableFactory'),
    validatorCreationCode: creationBytecode(find('PreparedTableValidator')), namespace: keccak256(stringToHex('network-independent local acceptance')), index: 0n };
  const config: AccountConfig = variant === 'experimental-general' ? { ...common, kernelFactory: address('KernelFactory') } : { ...common, profile: variant === 'general' ? 'general' : 'restricted',
    profilePreparationFactory: address('ProfilePreparationFactory'), profileFactoryCreationCode: creationBytecode(find('ProfileAccountFactory')),
    policy: variant === 'general' ? zeroAddress : address(variant === 'targets' ? 'TargetAllowlistPolicy' : 'SelectorAllowlistPolicy'),
    policyCodeHash: variant === 'general' ? zeroHash : d[variant === 'targets' ? 'TargetAllowlistPolicy' : 'SelectorAllowlistPolicy'].runtimeCodeHash,
    policyConfig: variant === 'general' ? '0x' : variant === 'targets' ? encodeTargetAllowlist([address('ExperimentCounter')]) : encodeSelectorAllowlist([{ target: address('ExperimentCounter'), selectors: [encodeFunctionData({ abi: find('ExperimentCounter').abi as Abi, functionName: 'increment', args: [1n] }).slice(0, 10) as Hex], allowEmpty: false, allowValue: false }]) };
  const binding = bindAddressArtifacts(config), application = 'https://local-acceptance.invalid';
  const options = { application, config, cardanoNetwork: 0 as const, store: new MemoryChallengeStore() };
  const service = 'profile' in config ? createProfileEnrollmentService({ ...options, config }) : createTableEnrollmentService({ ...options, config });
  const account = await enrollCardanoAccount({ wallet: cardanoWallet, application, config, cardanoNetwork: 0, credential: 'stake', cardanoAddress: rawHex(cardanoAddress), transport: { challenge: (a) => service.issue(a), enroll: (id, signature) => service.enroll(id, signature) } });
  assert.deepEqual(account.config, config);
  const independent = 'profile' in config ? deriveBackendProfileIdentity(account.publicKey, account.identity.protectedHeaders, config) : deriveBackendTableIdentity(account.publicKey, account.identity.protectedHeaders, config);
  assert.equal(normalized(account.identity), normalized(independent));
  const prep = accountPreparation(account);
  await transaction(local, await local.wallet.sendTransaction({ ...prep, gas: 15000000n }));
  const factory = accountFactory(account), identity = account.identity;
  if ('profile' in config) await verifyPreparedProfile(local.client, config, identity as ProfileIdentity);
  const prediction = 'profile' in config
    ? await local.client.readContract({ address: factory, abi: find('ProfileAccountFactory').abi as Abi, functionName: 'getAddress', args: [config.namespace, config.index] })
    : await local.client.readContract({ address: factory, abi: find('KernelFactory').abi as Abi, functionName: 'getAddress', args: [identity.initializeData, identity.accountSalt] });
  assert.equal(String(prediction).toLowerCase(), identity.account.toLowerCase());
  if ('profile' in config) {
    assert.equal(await local.client.readContract({ address: factory, abi: find('ProfileAccountFactory').abi as Abi, functionName: 'accountSalt', args: [config.namespace, config.index] }), identity.accountSalt);
    assert.equal(await local.client.readContract({ address: factory, abi: find('ProfileAccountFactory').abi as Abi, functionName: 'initializeData' }), identity.initializeData);
    assert.ok(matchesRuntime((await local.client.getCode({ address: factory }))!, find('ProfileAccountFactory')));
  }
  assert.equal(await local.client.getCode({ address: identity.account }), undefined);
  const receipt = await transaction(local, await local.wallet.sendTransaction({ to: factory, data: identity.factoryData, gas: 3000000n }));
  const trace = await local.rpc('debug_traceTransaction', [receipt.transactionHash, { tracer: 'callTracer' }]);
  const created = frames(trace).filter((f) => f.type === 'CREATE2');
  assert.equal(created.length, 1, 'Actual factory execution must create exactly one account');
  const actualAddress = created[0].to as Address;
  assert.equal(actualAddress.toLowerCase(), identity.account.toLowerCase());
  const accountCode = await local.client.getCode({ address: actualAddress });
  assert.equal(accountCode, `0x${kernelProxyInitCode(config.kernelImplementation).slice(2 + 34 * 2)}`);
  assert.equal(await local.client.getStorageAt({ address: actualAddress, slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' }), `0x${'0'.repeat(24)}${config.kernelImplementation.slice(2).toLowerCase()}`);
  assert.equal(String(await local.client.readContract({ address: actualAddress, abi: find('Kernel').abi as Abi, functionName: 'rootValidator' })).toLowerCase(), concatHex(['0x01', identity.validator]).toLowerCase());
  assert.equal(await local.client.readContract({ address: identity.validator, abi: find('PreparedTableValidator').abi as Abi, functionName: 'publicKey' }), toHex(publicKey));
  const dependencies = { factory: { address: factory, code: await local.client.getCode({ address: factory }) }, validator: { address: identity.validator, code: await local.client.getCode({ address: identity.validator }) },
    ...(account.profile === 'restricted' ? { hook: { address: (identity as ProfileIdentity).hook, code: await local.client.getCode({ address: (identity as ProfileIdentity).hook }) } } : {}) };
  await transaction(local, await local.wallet.writeContract({ address: config.entryPoint, abi: entryPoint07Abi, functionName: 'depositTo', args: [actualAddress], value: parseEther('0.1') }));
  local.accounts.set(variant, account);
  report.rows.push({ profile: account.profile, policyVariant: variant, chainId: local.chainId, config: account.config, artifactBinding: binding,
    sdk: identity, independentBackend: independent, factoryPrediction: prediction, actualDeployedAddress: actualAddress, deploymentTransaction: receipt.transactionHash,
    creationTrace: created, deployedAccountCode: accountCode, dependencies, allFourAddressesAgree: true }); save();
  console.log(`${local.chainId} ${variant}: prediction and actual deployment agree`);
}

async function replay(source: Local, destination: Local, variant: typeof variants[number]) {
  const a = source.accounts.get(variant)!, b = destination.accounts.get(variant)!;
  const find = addressArtifactSet().find, ep = a.config.entryPoint, counter = source.deployments.ExperimentCounter.address as Address;
  const getNonce = (local: Local) => local.client.readContract({ address: ep, abi: entryPoint07Abi, functionName: 'getNonce', args: [a.identity.account, 0n] });
  assert.equal(await getNonce(source), 0n); assert.equal(await getNonce(destination), 0n);
  const build = (account: CardanoAccount) => constructOperation(account, { nonce: 0n, deploy: false, calls: [{ target: counter, value: 0n, data: encodeFunctionData({ abi: find('ExperimentCounter').abi as Abi, functionName: 'increment', args: [1n] }) }], gas: { callGasLimit: 600000n, verificationGasLimit: 500000n, preVerificationGas: 100000n }, fees: { maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n } });
  const unsigned = build(a); assert.deepEqual(unsigned, build(b), 'Only the signing chain context differs');
  const hashA = operationHash(unsigned, source.chainId, ep), hashB = operationHash(unsigned, destination.chainId, ep);
  assert.notEqual(hashA, hashB);
  for (const [local, hash] of [[source, hashA], [destination, hashB]] as const) assert.equal(await local.client.readContract({ address: ep, abi: entryPoint07Abi, functionName: 'getUserOpHash', args: [packOperation(unsigned)] }), hash);
  const signedA = await signOperation(a, unsigned, cardanoWallet), signedB = await signOperation(b, unsigned, cardanoWallet);
  assert.notEqual(signedA.payload, signedB.payload); assert.notEqual(signedA.operation.signature, signedB.operation.signature);
  const send = (local: Local, operation: typeof unsigned) => local.wallet.writeContract({ address: ep, abi: entryPoint07Abi, functionName: 'handleOps', args: [[packOperation(operation)], submitter.address], gas: 3000000n });
  const positiveA = await transaction(source, await send(source, signedA.operation));
  assert.equal(inclusionFromReceipt({ chainId: source.chainId, entryPoint: ep, operation: signedA.operation }, positiveA).status, 'included');
  const rejected = await transaction(destination, await send(destination, signedA.operation), 'reverted');
  const rejectedTrace = await destination.rpc('debug_traceTransaction', [rejected.transactionHash, { tracer: 'callTracer' }]);
  const failure = decodeErrorResult({ abi: entryPoint07Abi, data: rejectedTrace.output });
  assert.equal(failure.errorName, 'FailedOp'); assert.equal(failure.args[1], 'AA24 signature error');
  const validationInput = encodeFunctionData({ abi: find('PreparedTableValidator').abi as Abi, functionName: 'validateUserOp', args: [packOperation(signedA.operation), hashB] });
  const validation = frames(rejectedTrace).filter((f) => f.to?.toLowerCase() === b.identity.validator.toLowerCase() && f.input?.toLowerCase() === validationInput.toLowerCase());
  assert.equal(validation.length, 1, 'Replay reached the real validator with destination-chain digest');
  assert.equal(BigInt(validation[0].output), 1n, 'The actual validator rejected the signature');
  assert.equal(await getNonce(destination), 0n, 'Failed replay cannot consume destination nonce');
  const positiveB = await transaction(destination, await send(destination, signedB.operation));
  assert.equal(inclusionFromReceipt({ chainId: destination.chainId, entryPoint: ep, operation: signedB.operation }, positiveB).status, 'included');
  assert.equal(await getNonce(source), 1n); assert.equal(await getNonce(destination), 1n);
  const positiveTrace = await destination.rpc('debug_traceTransaction', [positiveB.transactionHash, { tracer: 'callTracer' }]);
  assert.ok(frames(positiveTrace).some((f) => f.to?.toLowerCase() === b.identity.validator.toLowerCase() && f.output === toHex(0n, { size: 32 })));
  const evidence = { profile: a.profile, policyVariant: variant, sourceChain: source.chainId, destinationChain: destination.chainId,
    unsignedOperation: operationToJson(unsigned), account: a.identity.account, nonceBefore: '0', sourceHash: hashA, destinationHash: hashB,
    sourcePayload: signedA.payload, destinationPayload: signedB.payload, sourceSignature: signedA.operation.signature, destinationSignature: signedB.operation.signature,
    sourcePositiveTransaction: positiveA.transactionHash, rejectedReplayTransaction: rejected.transactionHash, rejection: { name: failure.errorName, reason: failure.args[1], validatorReturn: validation[0].output, validatorInput: validationInput },
    destinationPositiveTransaction: positiveB.transactionHash, nonceAfter: '1', sameUnsignedOperation: true, realValidatorReached: true, allControlsPassed: true };
  writeFileSync(`${out}/replay-${variant}.json`, json({ ...evidence, rejectedTrace, destinationPositiveTrace: positiveTrace }));
  report.replay.push(evidence); save(); console.log(`${variant}: real cross-chain replay rejected; destination signature accepted`);
}

try {
  const first = await start(chains[0], portBase), second = await start(chains[1], portBase + 1);
  await setup(first); await setup(second);
  for (const name of Object.keys(first.deployments)) {
    const a = first.deployments[name], b = second.deployments[name];
    assert.equal(a.nonce, b.nonce); assert.equal(a.address, b.address); assert.equal(a.data, b.data);
    assert.equal(a.deployedCode, b.deployedCode, `${name}: exact infrastructure bytes, including immutables`);
  }
  report.infrastructurePrerequisite = { addressesEqual: true, creationBytesAndConstructorsEqual: true, deployedBytesEqualWithoutMasking: true,
    kernelConstructorContext: chains[0], actualAccountAndOperationChainIds: chains,
    explanation: 'Only Kernel construction uses a common local chain context to preserve its pinned Solady EIP-712 runtime cache bytes. Both independent chains are restored to their distinct IDs before all account/enrollment/operation work. No anvil_setCode or modified contract is used.' }; save();
  for (const variant of variants) {
    await prepareAndDeploy(first, variant); await prepareAndDeploy(second, variant);
    const [a, b] = report.rows.slice(-2);
    assert.equal(normalized(a.dependencies), normalized(b.dependencies), 'Prepared infrastructure addresses and full runtime bytes must match');
    assert.equal(a.deployedAccountCode, b.deployedAccountCode);
    assert.equal(a.sdk.accountSalt, b.sdk.accountSalt); assert.equal(a.actualDeployedAddress, b.actualDeployedAddress);
    assert.equal(a.sdk.initializeData, b.sdk.initializeData); assert.equal(a.sdk.factoryData, b.sdk.factoryData);
    assert.notEqual(a.sdk.configHash, b.sdk.configHash);
    a.crossChainPrerequisitesChecked = b.crossChainPrerequisitesChecked = true; save();
  }
  for (const variant of variants) await replay(first, second, variant);
  assert.equal(report.rows.length, 8); assert.equal(report.replay.length, 4);
  report.allChecksPassed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error); throw error;
} finally {
  await stop(); process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
  report.servicesStopped = children.every((child) => child.exitCode !== null || child.signalCode !== null);
  report.completedAt = new Date().toISOString(); save();
}
console.log(json({ allChecksPassed: report.allChecksPassed, matrix: `${out}/matrix.json`, matrixSha256: createHash('sha256').update(readFileSync(`${out}/matrix.json`)).digest('hex'), rows: report.rows.length, replayControls: report.replay.length }));
