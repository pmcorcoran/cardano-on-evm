import { readProfileManifest } from '../lib/identity-manifest.js';
import './errors.js';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { parseArgs, parseEnv } from 'node:util';
import { dirname, resolve } from 'node:path';
import { createPublicClient, custom, keccak256, toHex, concatHex, encodeFunctionData, decodeFunctionData, type Abi, type Address } from 'viem';
import { baseSepolia } from 'viem/chains';
import { entryPoint07Abi } from 'viem/account-abstraction';
import { verifyCip8Signature, fromHex } from '../../packages/wallet/src/index.js';
import { accountFromVerifiedKey, accountFactory, operationFromJson, operationHash, operationPayload, validatorSignature, decodeCalls, decodeRestrictedCalls, packOperation, kernelProxyInitCode, type CardanoAccount } from '../../packages/sdk/src/index.js';
import { deriveBackendProfileIdentity, backendProfileConfigHash } from '../../packages/enrollment/src/identity.js';
import { createPublicBundlerAdapter, createPrivateBundlerAdapter, httpRpc, inclusionFromReceipt, type OperationContext } from '../../packages/submission/src/index.js';
import { canonicalReceipt } from '../lib/canonical-receipt.js';
import { artifacts, entryPoint, kernel, json, matchesRuntime, verifyPreparedProfile } from '../lib/live-context.js';
import { releaseEvidenceOutput } from '../lib/release-evidence.js';

const { values } = parseArgs({ options: { manifest: { type: 'string' }, captures: { type: 'string' }, application: { type: 'string' }, out: { type: 'string' }, 'private-secrets-file': { type: 'string' } } });
assert.ok(values.manifest && values.captures && values.application && values.out, '--manifest, --captures, --application and --out are required');
const manifest = readProfileManifest(values.manifest);
assert.equal(manifest.chainId, 84532, 'Expected Base Sepolia profile manifest');
assert.equal(manifest.infrastructureVerified, true, 'Verified infrastructure is required');
assert.ok(!manifest.testData, 'Generated loopback fixtures are not public-chain acceptance');
const application = new URL(values.application);
assert.ok(['http:', 'https:'].includes(application.protocol) && application.origin === values.application, 'An exact HTTP(S) application origin is required');
const directory = values.captures;
const files = existsSync(directory) ? readdirSync(directory).sort() : [];
const output = releaseEvidenceOutput(values.out, [values.manifest, ...files.map((name) => `${directory}/${name}`)]);
const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org';
const paced = httpRpc(rpcUrl, { minimumIntervalMs: 350 });
const rpc = async (method: string, params: readonly unknown[]): Promise<any> => {
  for (let attempt = 0; ; attempt++) {
    try { return await paced(method, params); }
    catch (error) {
      if (attempt >= 3 || !(error instanceof Error) || !/429|timed out/.test(error.message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
};
const client = createPublicClient({ chain: baseSepolia, transport: custom({ request: ({ method, params }) => rpc(method, params ?? []) }) }), find = artifacts();
assert.equal(await client.getChainId(), 84532);
const enrolled = new Map<string, { account: CardanoAccount; profile: string }>();
const out: any = { kind: 'independent-reference-application-acceptance', observedAt: new Date().toISOString(), chainId: 84532, signatureSource: manifest.testData ? 'generated test data' : 'operator-provided captures', enrollment: [], operations: [], pending: [] };
for (const file of files.filter((f) => /^enrollment-[a-f0-9]{64}\.json$/.test(f))) {
  const path = `${directory}/${file}`, capture = JSON.parse(readFileSync(path, 'utf8')), p = manifest.profiles[capture.profile];
  assert.ok(p); const config = { ...p.config, index: BigInt(p.config.index) };
  assert.equal(config.entryPoint.toLowerCase(), entryPoint.toLowerCase()); assert.equal(config.kernelImplementation.toLowerCase(), kernel.toLowerCase());
  assert.equal(capture.testData, false, 'Acceptance requires operator captures from the verified infrastructure');
  const c = capture.challenge;
  assert.equal(c.application, values.application); assert.equal(c.baseChainId, 84532); assert.equal(c.cardanoNetwork, 0);
  assert.equal(c.configHash, backendProfileConfigHash(config));
  assert.match(c.id, /^[0-9a-f]{64}$/);
  assert.equal(file, `enrollment-${c.id}.json`);
  assert.ok(Number.isSafeInteger(c.issuedAt) && Number.isSafeInteger(c.expiresAt));
  assert.ok(c.expiresAt > c.issuedAt && c.expiresAt - c.issuedAt <= 900000);
  const canonicalChallenge = JSON.stringify({ domain: 'cardano-kernel:enrollment:v1', challenge: c.id, application: c.application, cardanoAddress: c.cardanoAddress, cardanoNetwork: c.cardanoNetwork, baseChainId: c.baseChainId, configHash: c.configHash, issuedAt: c.issuedAt, expiresAt: c.expiresAt });
  assert.equal(toHex(fromHex(c.payloadHex)), toHex(new TextEncoder().encode(canonicalChallenge)), 'Signed challenge must contain its declared enrollment scope');
  const signed = verifyCip8Signature(capture.signed, { address: c.cardanoAddress, network: 0, payload: fromHex(c.payloadHex) });
  const account = accountFromVerifiedKey(signed, config);
  assert.equal(account.publicKey, p.publicKey, 'Enrollment key differs from the supplied prepared identity');
  const backend = deriveBackendProfileIdentity(account.publicKey, account.identity.protectedHeaders, config);
  for (const identity of [backend, capture.verified.identity, capture.sdkAccount.identity, p.identity]) assert.equal(json(identity).toLowerCase(), json(account.identity).toLowerCase());
  assert.equal(json(capture.sdkAccount.config).toLowerCase(), json(account.config).toLowerCase(), 'Captured SDK configuration differs from the supplied manifest');
  await verifyPreparedProfile(client, config, p.identity);
  enrolled.set(resolve(path), { account, profile: capture.profile });
  out.enrollment.push({ file: path, profile: capture.profile, wallet: capture.wallet, account: account.identity.account, publicKey: account.publicKey, freshConfigurationBoundChallenge: true, sdkBackendAndDeployedPredictionAgree: true });
}
const allFrames = (frame: any): any[] => [frame, ...(frame.calls ?? []).flatMap(allFrames)];
async function state(account: CardanoAccount, blockNumber: bigint) {
  const address = account.identity.account;
  const [balance, deposit, nonce, code] = await Promise.all([client.getBalance({ address, blockNumber }), client.readContract({ address: entryPoint, abi: entryPoint07Abi, functionName: 'balanceOf', args: [address], blockNumber }), client.readContract({ address: entryPoint, abi: entryPoint07Abi, functionName: 'getNonce', args: [address, 0n], blockNumber }), client.getCode({ address, blockNumber })]);
  return { balance, deposit, nonce, code };
}
for (const file of files.filter((f) => /^operation-[a-f0-9]{64}\.json$/.test(f))) {
  const path = `${directory}/${file}`, saved = JSON.parse(readFileSync(path, 'utf8')), session = enrolled.get(resolve(saved.enrollmentFile));
  assert.ok(session, 'Operation must reference a verified fresh enrollment');
  assert.ok(['public', 'private', 'direct'].includes(saved.mode), 'Unknown recorded submission mode');
  const { account, profile } = session, operation = operationFromJson(saved.context.operation), p = manifest.profiles[profile];
  const context: OperationContext = { chainId: 84532, entryPoint, operation };
  assert.equal(saved.context.chainId, 84532); assert.equal(saved.context.entryPoint.toLowerCase(), entryPoint.toLowerCase());
  const hash = operationHash(operation, 84532, entryPoint); assert.equal(file, `operation-${hash.slice(2)}.json`);
  const signed = verifyCip8Signature(saved.authorization, { address: account.cardanoAddress, network: 0, payload: fromHex(operationPayload(operation, 84532, entryPoint)) });
  assert.equal(toHex(signed.publicKey), account.publicKey); assert.equal(keccak256(signed.protectedHeaders), account.protectedHeaderHash); assert.equal(validatorSignature(signed), operation.signature);
  assert.equal(operation.sender.toLowerCase(), account.identity.account.toLowerCase());
  if (operation.factory) { assert.equal(operation.factory.toLowerCase(), accountFactory(account).toLowerCase()); assert.equal(operation.factoryData, account.identity.factoryData); }
  let hashOfTx = saved.inclusion?.transactionHash ?? saved.submission?.transactionHash;
  if (!hashOfTx && saved.mode !== 'direct') {
    let adapter;
    if (saved.mode === 'public') adapter = createPublicBundlerAdapter(httpRpc(process.env.PUBLIC_BUNDLER_RPC_URL ?? 'https://public.pimlico.io/v2/84532/rpc', { minimumIntervalMs: 3500 }));
    else {
      assert.ok(values['private-secrets-file'], '--private-secrets-file is required to query private operation status');
      const env = parseEnv(readFileSync(values['private-secrets-file']!, 'utf8'));
      assert.ok(env.BUNDLER_AUTH_TOKEN, 'A private status access token is required');
      adapter = createPrivateBundlerAdapter(httpRpc('http://127.0.0.1:4337/rpc', { headers: { authorization: `Bearer ${env.BUNDLER_AUTH_TOKEN}` } }));
    }
    const status = await adapter.status(context, { mode: saved.mode, userOperationHash: hash }); hashOfTx = status.transactionHash;
  }
  if (!hashOfTx) { out.pending.push({ file: path, profile, mode: saved.mode, hash }); continue; }
  const receipt = await canonicalReceipt(client, hashOfTx), inclusion = inclusionFromReceipt(context, receipt);
  assert.equal(inclusion.status, 'included');
  assert.ok(matchesRuntime((await client.getCode({ address: p.counter, blockNumber: receipt.blockNumber }))!, find('ExperimentCounter')));
  const [before, after] = await Promise.all([state(account, receipt.blockNumber - 1n), state(account, receipt.blockNumber)]);
  assert.equal(before.nonce, operation.nonce); assert.equal(after.nonce, operation.nonce + 1n);
  assert.equal(after.code?.toLowerCase(), `0x${kernelProxyInitCode(kernel).slice(2 + 34 * 2)}`.toLowerCase());
  const implementation = await client.getStorageAt({ address: operation.sender, slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', blockNumber: receipt.blockNumber });
  assert.equal(implementation?.toLowerCase(), `0x${'0'.repeat(24)}${kernel.slice(2).toLowerCase()}`);
  const root = await client.readContract({ address: operation.sender, abi: find('Kernel').abi as Abi, functionName: 'rootValidator', blockNumber: receipt.blockNumber });
  assert.equal(String(root).toLowerCase(), concatHex(['0x01', account.identity.validator]).toLowerCase());
  const validation: any = await client.readContract({ address: operation.sender, abi: find('Kernel').abi as Abi, functionName: 'validationConfig', args: [root], blockNumber: receipt.blockNumber });
  const expectedHook = profile === 'general' ? '0x0000000000000000000000000000000000000001' : p.identity.hook;
  assert.equal(validation.hook.toLowerCase(), expectedHook.toLowerCase()); assert.equal(validation.nonce, 1);
  assert.equal(await client.readContract({ address: account.identity.validator, abi: find('PreparedTableValidator').abi as Abi, functionName: 'publicKey', blockNumber: receipt.blockNumber }), account.publicKey);
  if (profile !== 'general') {
    assert.ok(matchesRuntime((await client.getCode({ address: expectedHook, blockNumber: receipt.blockNumber }))!, find('RestrictedExecutionHook')));
    for (const [fn, wanted] of [['policy', p.config.policy], ['configuration', p.config.policyConfig], ['policyCodeHash', p.config.policyCodeHash], ['entryPoint', entryPoint]]) assert.equal(String(await client.readContract({ address: expectedHook, abi: find('RestrictedExecutionHook').abi as Abi, functionName: fn!, blockNumber: receipt.blockNumber })).toLowerCase(), wanted.toLowerCase());
  }
  const calls = profile === 'general' ? decodeCalls(operation.callData) : decodeRestrictedCalls(operation.callData);
  const value = calls.reduce((sum, call) => sum + call.value, 0n);
  assert.equal(before.balance - after.balance, value); assert.equal(before.deposit - after.deposit, inclusion.actualGasCost);
  const trace = await rpc('debug_traceTransaction', [receipt.transactionHash, { tracer: 'callTracer' }]), frames = allFrames(trace);
  const executed = frames.filter((f) => f.type === 'CALL' && f.from?.toLowerCase() === operation.sender.toLowerCase() && calls.some((c) => c.target.toLowerCase() === f.to?.toLowerCase()));
  assert.equal(executed.length, calls.length);
  let counterChange = 0n;
  for (const [i, call] of calls.entries()) {
    const frame = executed[i]; assert.equal(frame.to.toLowerCase(), call.target.toLowerCase()); assert.equal(frame.input ?? '0x', call.data); assert.equal(BigInt(frame.value ?? 0), call.value); assert.ok(!frame.error);
    if (call.target.toLowerCase() === p.counter.toLowerCase()) {
      const decoded = decodeFunctionData({ abi: find('ExperimentCounter').abi as Abi, data: call.data }); assert.equal(decoded.functionName, 'increment'); counterChange += BigInt(decoded.args![0] as bigint);
    } else { assert.equal(call.target.toLowerCase(), p.permittedRecipient.toLowerCase()); assert.equal(call.data, '0x'); }
  }
  const validationInput = encodeFunctionData({ abi: find('PreparedTableValidator').abi as Abi, functionName: 'validateUserOp', args: [packOperation(operation), hash] });
  const verifierFrames = frames.filter((f) => f.from?.toLowerCase() === operation.sender.toLowerCase() && f.to?.toLowerCase() === account.identity.validator.toLowerCase() && f.input?.toLowerCase() === validationInput.toLowerCase()); assert.equal(verifierFrames.length, 1);
  assert.ok(!verifierFrames[0].error); assert.equal(BigInt(verifierFrames[0].output), 0n);
  const evidence = { file: path, enrollmentFile: saved.enrollmentFile, profile, mode: saved.mode, account: operation.sender, nonce: operation.nonce, hash, status: 'included-and-independently-verified', transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, before, after, root, validation, calls, authorizedExecutionTraceMatches: true, intendedCounterIncrement: counterChange, deliveredNativeValue: value, entryPointCost: inclusion.actualGasCost, gas: { transaction: receipt.gasUsed, validatorFrame: BigInt(verifierFrames[0].gasUsed), isolatedVerifierEstimate: false }, receipt };
  out.operations.push(evidence);
}
out.privateReferenceProfiles = [...new Set(out.operations.filter((o: any) => o.mode === 'private').map((o: any) => o.profile))];
out.privateReferenceFlowAllProfilesPassed = ['general', 'targets', 'selectors'].every((name) => out.privateReferenceProfiles.includes(name));
assert.ok(out.enrollment.length > 0 && out.operations.length > 0, 'Supply completed enrollment and operation captures'); assert.equal(out.pending.length, 0);
assert.equal(new Set(out.operations.map((operation: any) => operation.hash)).size, out.operations.length);
for (const profile of ['general', 'targets', 'selectors']) {
  const repeated = out.enrollment.filter((enrollment: any) => enrollment.profile === profile);
  assert.ok(repeated.length >= 2, 'Repeated enrollment controls are required for every profile'); assert.equal(new Set(repeated.map((enrollment: any) => enrollment.account)).size, 1);
}
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, json(out), { flag: 'wx' });
console.log(json({ file: values.out, enrollments: out.enrollment.length, operations: out.operations.map(({ profile, mode, transactionHash }: any) => ({ profile, mode, transactionHash })), pending: out.pending, privateReferenceFlowAllProfilesPassed: out.privateReferenceFlowAllProfilesPassed }));
