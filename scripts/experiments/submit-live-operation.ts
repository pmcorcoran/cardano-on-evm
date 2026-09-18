import { dirname } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { concatHex, decodeFunctionData, encodeFunctionData, getAddress, keccak256, toHex, type Abi, type Hex } from 'viem';
import { entryPoint07Abi } from 'viem/account-abstraction';
import { fromHex, verifyCip8Signature } from '../../packages/wallet/src/index.js';
import { decodeCalls, decodeRestrictedCalls, kernelProxyInitCode, operationFromJson, operationHash, packOperation, validatorSignature } from '../../packages/protocol/src/index.js';
import { createDirectAdapter, createPublicBundlerAdapter, createPrivateBundlerAdapter, httpRpc, inclusionFromReceipt, RpcError, type Submission, type Inclusion } from '../../packages/submission/src/index.js';
import { checkLiveRequest } from '../lib/live-request.js';
import { liveContext, matchesRuntime, entryPoint, kernel, json } from '../lib/live-context.js';
import { canonicalReceipt } from '../lib/canonical-receipt.js';
import { assertPrivateStopped } from '../lib/private-stopped.js';
import { readTableIdentityManifest } from '../lib/identity-manifest.js';
import { assertLiveConfig } from '../lib/live-context.js';

let stage = 'load saved authorization'; let file: string | undefined; let state: any;
let live: Awaited<ReturnType<typeof liveContext>> | undefined;
const save = () => { if (file && state) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, json(state)); } };
try {
  const { values } = parseArgs({ options: { request: { type: 'string' }, signature: { type: 'string' }, infrastructure: { type: 'string' }, journal: { type: 'string' }, out: { type: 'string' }, lifecycle: { type: 'string' }, identity: { type: 'string' }, 'key-file': { type: 'string' }, 'key-variable': { type: 'string', default: 'SUBMITTER_PRIVATE_KEY' }, 'private-secrets-file': { type: 'string', default: '.local/private-bundler/base-sepolia.env' }, send: { type: 'boolean', default: false }, 'require-private-stopped': { type: 'boolean', default: false } } });
  if (!values.request || !values.signature || !values.infrastructure || !values.journal || !values.out || !values['key-file']) throw new Error('--request, --signature, --infrastructure, --journal, --out and --key-file are required');
  if (values['require-private-stopped'] && !values.lifecycle) throw new Error('--lifecycle is required for stopped-service verification');
  const captured = JSON.parse(readFileSync(values.signature, 'utf8'));
  const request = JSON.parse(readFileSync(values.request, 'utf8'));
  checkLiveRequest(request);
  if (request.purpose) throw new Error('Use the expected-policy-rejection runner for this request');
  const verified = verifyCip8Signature(captured.signed, { address: request.cardanoAddress, network: request.cardanoNetwork, payload: fromHex(request.payloadHex) });
  const operation = operationFromJson(captured.operation);
  if (operationHash(operation, 84532, entryPoint) !== request.userOperationHash || operation.signature !== validatorSignature(verified) || toHex(verified.publicKey).toLowerCase() !== request.publicKey.toLowerCase() || keccak256(verified.protectedHeaders) !== request.protectedHeaderHash) throw new Error('Saved authorization differs from its request');
  const identityEvidence = values.identity ? readTableIdentityManifest(values.identity) : undefined;
  if (identityEvidence && (identityEvidence.identity.account.toLowerCase() !== operation.sender.toLowerCase() || identityEvidence.identity.validator.toLowerCase() !== request.validator.toLowerCase() || identityEvidence.identity.publicKey.toLowerCase() !== request.publicKey.toLowerCase() || keccak256(identityEvidence.identity.protectedHeaders) !== request.protectedHeaderHash)) throw new Error('Identity manifest differs from the signed account');
  file = values.out;
  state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { kind: 'base-sepolia-signed-account-operation', requestId: request.id, createdAt: new Date().toISOString(), mode: request.mode, chainId: 84532, entryPoint, userOperationHash: request.userOperationHash, signatureFile: values.signature, privateBundlerRunning: false, status: 'prepared', attempts: [] };
  if (state.userOperationHash !== request.userOperationHash || state.mode !== request.mode || state.requestId !== request.id || state.chainId !== 84532 || state.entryPoint.toLowerCase() !== entryPoint.toLowerCase() || state.signatureFile !== values.signature) throw new Error('Submission journal context changed');
  if (values['require-private-stopped'] && request.mode === 'private') throw new Error('Private submission cannot be used for stopped-service portability');
  stage = 'verify Base Sepolia deployments';
  live = await liveContext(values['key-file'], values['key-variable']!, { manifest: values.infrastructure, journal: values.journal, independentSubmitter: true });
  const { client, find, account, transact, counter, journalFile } = live;
  if (identityEvidence) assertLiveConfig(identityEvidence.config, live);
  try { const response = await fetch('http://127.0.0.1:4337/health', { signal: AbortSignal.timeout(1500) }); state.privateBundlerRunning = response.ok; }
  catch { state.privateBundlerRunning = false; }
  state.privateServiceObservation = { checkedAt: new Date().toISOString(), loopbackHealthPort: 4337, reachable: state.privateBundlerRunning }; save();
  const rpc = httpRpc(process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org');
  const context = { chainId: 84532, entryPoint, operation };
  const publicRpc = httpRpc(process.env.PUBLIC_BUNDLER_RPC_URL ?? 'https://public.pimlico.io/v2/84532/rpc', { minimumIntervalMs: 3500 });
  let privateRpc;
  if (request.mode === 'private') {
    const env = parseEnv(readFileSync(values['private-secrets-file']!, 'utf8'));
    if (!env.BUNDLER_AUTH_TOKEN || !state.privateBundlerRunning) throw new Error('Private service or access token is unavailable');
    privateRpc = httpRpc('http://127.0.0.1:4337/rpc', { headers: { authorization: `Bearer ${env.BUNDLER_AUTH_TOKEN}` }, timeoutMs: 55000 });
  }
  const adapter = request.mode === 'public' ? createPublicBundlerAdapter(publicRpc) : request.mode === 'private' ? createPrivateBundlerAdapter(privateRpc!) : createDirectAdapter({ rpc, submitter: account.address, sendTransaction: async (intent) => {
    const receipt = await transact(`operation-${request.id}`, intent, values.send);
    if (!receipt) throw new Error('Direct send was not requested'); return receipt.transactionHash;
  } });
  const readState = async (blockNumber: bigint) => {
    const code = await client.getCode({ address: operation.sender, blockNumber });
    const deposit = await client.readContract({ address: entryPoint, abi: entryPoint07Abi, functionName: 'balanceOf', args: [operation.sender], blockNumber });
    const balance = await client.getBalance({ address: operation.sender, blockNumber });
    const nonce = await client.readContract({ address: entryPoint, abi: entryPoint07Abi, functionName: 'getNonce', args: [operation.sender, 0n], blockNumber });
    const counterValue = await client.readContract({ address: counter, abi: find('ExperimentCounter').abi as Abi, functionName: 'number', blockNumber }) as bigint;
    return { blockNumber, code: code ?? '0x', deposit, balance, nonce, counterValue };
  };
  let submission: Submission | undefined = state.submission;
  if (!submission && request.mode === 'direct' && existsSync(journalFile)) {
    const journal = JSON.parse(readFileSync(journalFile, 'utf8'));
    const existing = journal.transactions[`operation-${request.id}`];
    if (existing) {
      const wanted = encodeFunctionData({ abi: entryPoint07Abi, functionName: 'handleOps', args: [[packOperation(operation)], account.address] });
      if (existing.to.toLowerCase() !== entryPoint.toLowerCase() || existing.data.toLowerCase() !== wanted.toLowerCase()) throw new Error('Journal transaction intent mismatch');
      submission = { mode: 'direct', userOperationHash: request.userOperationHash, transactionHash: existing.transactionHash };
      state.submission = submission; save();
    }
  }
  // If a previous broadcast was ambiguous, query its stable UserOp hash before
  // attempting the same authorization again. No new signature or nonce is made.
  if (!submission && state.status === 'broadcast-result-unknown' && request.mode !== 'direct') {
    const candidate: Submission = { mode: request.mode, userOperationHash: request.userOperationHash };
    const observed = await adapter.status(context, candidate);
    if (observed.status !== 'pending') { submission = candidate; state.submission = submission; save(); }
  }
  if (!submission) {
    stage = 'simulate full EntryPoint and Kernel operation';
    if (state.before) { state.previousAttemptStates ??= []; state.previousAttemptStates.push(state.before); }
    state.before = await readState(await client.getBlockNumber({ cacheTime: 0 })); save();
    const handleOps = encodeFunctionData({ abi: entryPoint07Abi, functionName: 'handleOps', args: [[packOperation(operation)], account.address] });
    await rpc('eth_call', [{ from: account.address, to: entryPoint, data: handleOps }, 'latest']);
    state.simulation = { at: new Date().toISOString(), rpc: 'normal Base Sepolia JSON-RPC', verificationGasLimit: operation.verificationGasLimit.toString(), success: true }; save();
    console.log(json({ status: 'full-path-simulation-passed', requestId: request.id, mode: request.mode, account: operation.sender, nonce: operation.nonce, verificationGasLimit: operation.verificationGasLimit }));
    if (values.send) {
      if (values['require-private-stopped']) { state.privateStopped = { beforeBroadcast: await assertPrivateStopped(values.lifecycle!) }; save(); }
      stage = request.mode === 'public' ? 'submit to Pimlico public bundler' : request.mode === 'private' ? 'submit through supplied private Alto gateway' : 'submit direct EntryPoint transaction';
      state.status = 'broadcast-result-unknown'; state.attempts.push({ at: new Date().toISOString(), stage }); save();
      submission = await adapter.submit(context); state.submission = submission; state.status = 'submitted'; save();
      console.log(json({ status: 'submitted', requestId: request.id, ...submission }));
    }
  }
  if (submission) {
    stage = 'observe matching EntryPoint receipt';
    let included: Inclusion = await adapter.status(context, submission);
    for (let attempt = 0; included.status === 'pending' && attempt < 6; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5000)); included = await adapter.status(context, submission);
    }
    if (included.status === 'pending') { state.status = 'pending'; save(); console.log(json({ requestId: request.id, status: 'pending', submission })); }
    else {
      if (!included.transactionHash) throw new Error('Receipt has no transaction hash');
      // Independently fetch the transaction through normal Base RPC even for
      // public submission. The bundler response alone is not acceptance proof.
      stage = 'wait for a mined receipt matching its Base Sepolia block';
      const receipt = await canonicalReceipt(client, included.transactionHash);
      const checked = inclusionFromReceipt(context, receipt);
      state.inclusion = checked; state.transactionHash = receipt.transactionHash; state.status = checked.status; save();
      if (checked.status !== 'included') throw new Error('The authorized operation did not execute successfully');
      stage = 'verify deployed identity, owner, configuration and effects';
      const after = await readState(receipt.blockNumber);
      const expectedCode = `0x${kernelProxyInitCode(kernel).slice(2 + 34 * 2)}`;
      if (after.code.toLowerCase() !== expectedCode.toLowerCase()) throw new Error('Account is not the predicted ERC1967 proxy');
      const slot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const;
      const implementation = await client.getStorageAt({ address: operation.sender, slot, blockNumber: receipt.blockNumber });
      if (implementation?.toLowerCase() !== `0x${'0'.repeat(24)}${kernel.slice(2).toLowerCase()}`) throw new Error('Account implementation differs');
      const kernelAbi = find('Kernel').abi as Abi;
      const root = await client.readContract({ address: operation.sender, abi: kernelAbi, functionName: 'rootValidator', blockNumber: receipt.blockNumber }) as Hex;
      if (root.toLowerCase() !== concatHex(['0x01', request.validator]).toLowerCase()) throw new Error('Account root differs from Cardano validator');
      const validation = await client.readContract({ address: operation.sender, abi: kernelAbi, functionName: 'validationConfig', args: [root], blockNumber: receipt.blockNumber }) as { hook: Hex; nonce: number };
      const expectedHook = request.profile === 'restricted' ? request.profileDetails.hook : '0x0000000000000000000000000000000000000001';
      if (getAddress(validation.hook) !== getAddress(expectedHook) || validation.nonce !== 1) throw new Error('Unexpected initial validator configuration');
      if (request.profileDetails) {
        const details = request.profileDetails;
        if (!matchesRuntime((await client.getCode({ address: details.factory, blockNumber: receipt.blockNumber }))!, find('ProfileAccountFactory'))) throw new Error('Profile factory runtime differs');
        if (await client.readContract({ address: details.factory, abi: find('ProfileAccountFactory').abi as Abi, functionName: 'profileHash', blockNumber: receipt.blockNumber }) !== details.profileHash) throw new Error('Profile commitment differs');
        if (request.profile === 'restricted') {
          if (!matchesRuntime((await client.getCode({ address: details.hook, blockNumber: receipt.blockNumber }))!, find('RestrictedExecutionHook'))) throw new Error('Restricted hook runtime differs');
          for (const [fn, expected] of [['entryPoint', entryPoint], ['policy', details.policy], ['policyCodeHash', details.policyCodeHash], ['configuration', details.policyConfig]]) {
            const actual: unknown = await client.readContract({ address: details.hook, abi: find('RestrictedExecutionHook').abi as Abi, functionName: fn!, blockNumber: receipt.blockNumber });
            if (String(actual).toLowerCase() !== expected.toLowerCase()) throw new Error('Restricted policy configuration changed');
          }
        }
        state.profileChecks = { factoryAndProfileCommitment: true, restrictedHookAndPolicyChecked: request.profile === 'restricted', profileHash: details.profileHash, hook: expectedHook };
      }
      const owner = await client.readContract({ address: request.validator, abi: find('PreparedTableValidator').abi as Abi, functionName: 'publicKey', blockNumber: receipt.blockNumber });
      if (owner !== request.publicKey || after.nonce !== operation.nonce + 1n) throw new Error('Owner or EntryPoint nonce differs');
      const calls = request.profile === 'restricted' ? decodeRestrictedCalls(operation.callData) : decodeCalls(operation.callData);
      const intendedValue = calls.reduce((total, call) => total + call.value, 0n);
      if (BigInt(state.before.balance) - after.balance !== intendedValue || BigInt(state.before.deposit) - after.deposit !== checked.actualGasCost) throw new Error('Account balance/deposit effects differ');
      let intendedCounterChange = 0n;
      for (const call of calls) {
        if (call.data === '0x') continue; // Native transfers are checked by account balance change.
        if (call.target.toLowerCase() !== counter.toLowerCase()) throw new Error('This experiment only verifies counter calls');
        const decoded = decodeFunctionData({ abi: find('ExperimentCounter').abi as Abi, data: call.data });
        if (decoded.functionName === 'increment') intendedCounterChange += BigInt(decoded.args![0] as bigint);
        else throw new Error('Unknown counter action');
      }
      if (after.counterValue - BigInt(state.before.counterValue) !== intendedCounterChange) throw new Error('Counter effect differs from the authorized calls');
      state.after = after;
      state.canonicalReceipt = { blockHash: receipt.blockHash, blockNumber: receipt.blockNumber, matchedMinedBlock: true };
      state.identityChecks = { predictedAddressDeployed: true, proxyRuntimeAndImplementationChecked: true, rootValidator: root, publicKey: owner, validation, sameOwner: true, nonceAdvancedOnce: true, accountBalanceChangeWei: intendedValue, entryPointDepositChangeWei: checked.actualGasCost, counterChange: intendedCounterChange };
      state.status = 'included-and-verified'; state.completedAt = new Date().toISOString(); save();
      if (values['require-private-stopped']) {
        if (!state.privateStopped?.beforeBroadcast) throw new Error('No pre-broadcast stopped-service observation was recorded');
        state.privateStopped.afterReceipt = await assertPrivateStopped(values.lifecycle!); save();
      }
      const identityFile = values.identity;
      if (identityFile && identityEvidence) { identityEvidence.deployedAccountChecked = true; identityEvidence.deploymentOrExecutionEvidence = file; writeFileSync(identityFile, json(identityEvidence)); }
      console.log(json({ requestId: request.id, mode: request.mode, account: operation.sender, status: state.status, transactionHash: receipt.transactionHash, totalTransactionGas: receipt.gasUsed, entryPointActualGasUsed: checked.actualGasUsed, entryPointActualGasCost: checked.actualGasCost, counterBefore: state.before.counterValue, counterAfter: after.counterValue, file }));
    }
  }
} catch (error) {
  const detail = error instanceof RpcError ? { rpcCode: error.code, message: error.message } : { message: String(error).match(/AA\d\d [A-Za-z0-9 .()_-]+/)?.[0]?.slice(0, 300) ?? 'Verification or RPC step failed; endpoint and secret configuration withheld' };
  if (state) { state.errors ??= []; state.errors.push({ at: new Date().toISOString(), stage, ...detail }); if (state.status === 'prepared') state.status = 'simulation-failed'; save(); }
  console.error(json({ status: 'check-pending-or-failed', stage, ...detail, evidence: file })); process.exitCode = 1;
} finally { live?.release(); }
