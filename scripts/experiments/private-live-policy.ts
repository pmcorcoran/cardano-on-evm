import './errors.js';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { createPublicClient, custom, encodeFunctionData, encodeErrorResult, decodeFunctionResult, keccak256, toHex, type Abi, type Hex } from 'viem';
import { entryPoint07Abi } from 'viem/account-abstraction';
import { fromHex, verifyCip8Signature } from '../../packages/wallet/src/index.js';
import { operationFromJson, operationHash, packOperation, validatorSignature, decodeRestrictedCalls } from '../../packages/protocol/src/index.js';
import { httpRpc, RpcError, createPrivateBundlerAdapter, inclusionFromReceipt } from '../../packages/submission/src/index.js';
import { canonicalReceipt } from '../lib/canonical-receipt.js';
import { checkLiveRequest } from '../lib/live-request.js';
import { artifacts, matchesRuntime, json } from '../lib/live-context.js';
import { readProfileManifest } from '../lib/identity-manifest.js';
// Standalone JS service remains a separately installed infrastructure package.
// @ts-expect-error JavaScript infrastructure has no core-package dependency.
import { startService } from '../../infra/bundler/src/service.mjs';

const { values } = parseArgs({ options: { ids: { type: 'string' }, manifest: { type: 'string' }, requests: { type: 'string' }, signatures: { type: 'string' }, config: { type: 'string' }, 'config-out': { type: 'string' }, 'secrets-file': { type: 'string' }, 'rpc-url': { type: 'string' }, out: { type: 'string' }, send: { type: 'boolean', default: false } } });
assert.ok(values.manifest && values.requests && values.signatures && values.config && values['config-out'] && values['rpc-url'] && values.out, 'Supply --manifest, --requests, --signatures, --config, --config-out, --rpc-url and --out');
assert.notEqual(resolve(values.config), resolve(values['config-out']), 'The working configuration must use a separate output path');
const setup = readProfileManifest(values.manifest);
const original = JSON.parse(readFileSync(values.config, 'utf8'));
const chainId = setup.chainId, entryPoint = original.entryPoint;
assert.equal(original.chainId, chainId);
const ids = values.ids?.split(',') ?? [];
assert.ok(ids.length > 0 && ids.length <= 2 && ids.every((id) => /^[0-9a-f]{64}$/.test(id)));
if (!values.send) throw new Error('This acceptance runner requires --send for the explicitly reviewed rejection requests');
const cases = ids.map((id) => {
  const request = JSON.parse(readFileSync(join(values.requests!, `${id}.json`), 'utf8'));
  checkLiveRequest(request); assert.equal(request.purpose, 'expected-policy-rejection'); assert.equal(request.mode, 'private');
  assert.equal(request.chainId, chainId); assert.equal(request.entryPoint.toLowerCase(), entryPoint.toLowerCase());
  const profile = setup.profiles[request.profileDetails.name];
  assert.ok(profile?.identity, 'Manifest must bind this reviewed profile identity');
  assert.equal(profile.config.entryPoint.toLowerCase(), entryPoint.toLowerCase());
  assert.equal(profile.identity.account.toLowerCase(), request.operation.sender.toLowerCase());
  assert.equal(profile.identity.validator.toLowerCase(), request.validator.toLowerCase());
  assert.equal(profile.identity.hook.toLowerCase(), request.profileDetails.hook.toLowerCase());
  assert.equal(profile.config.policy.toLowerCase(), request.profileDetails.policy.toLowerCase());
  assert.equal(profile.config.policyConfig, request.profileDetails.policyConfig);
  assert.equal(profile.config.policyCodeHash, request.profileDetails.policyCodeHash);
  const saved = JSON.parse(readFileSync(join(values.signatures!, `${id}.json`), 'utf8'));
  const verified = verifyCip8Signature(saved.signed, { address: request.cardanoAddress, network: request.cardanoNetwork, payload: fromHex(request.payloadHex) });
  const operation = operationFromJson(saved.operation);
  assert.equal(validatorSignature(verified), operation.signature); assert.equal(toHex(verified.publicKey), request.publicKey);
  assert.equal(keccak256(verified.protectedHeaders), request.protectedHeaderHash);
  assert.equal(operationHash(operation, chainId, entryPoint), request.userOperationHash);
  const calls = decodeRestrictedCalls(operation.callData); assert.equal(calls.length, 1); assert.equal(calls[0]!.value, 0n);
  return { id, request, operation, call: calls[0]! };
});
const rpc = httpRpc(values['rpc-url'], { minimumIntervalMs: 350 });
const client = createPublicClient({ transport: custom({ request: ({ method, params }) => rpc(method, (params ?? []) as readonly unknown[]) }), pollingInterval: 1500 });
assert.equal(await client.getChainId(), chainId);
const find = artifacts();
const config = structuredClone(original), configPath = values['config-out'];
const env = { ...process.env, ...(values['secrets-file'] ? parseEnv(readFileSync(values['secrets-file'], 'utf8')) : {}) };
assert.ok(env[config.authTokenEnv]);
assert.equal(env[config.rpcUrlEnv], values['rpc-url'], 'Service and independent verification must use the same RPC');
mkdirSync(dirname(configPath), { recursive: true }); mkdirSync(dirname(values.out), { recursive: true });
writeFileSync(configPath, json(config));
const file = values.out;
const output: any = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { kind: 'private-admission-replacement-and-immutable-policy-rejection', chainId, artifactIdentity: setup.artifactIdentity, authorizationSource: 'supplied-CIP-8-signatures', records: [] };
assert.equal(output.chainId, chainId); assert.deepEqual(output.artifactIdentity, setup.artifactIdentity);
if (output.failure) { (output.previousFailures ??= []).push(output.failure); delete output.failure; }
const save = () => writeFileSync(file, json(output));
const service = await startService({ configPath, env, statePath: file.replace(/\.json$/, '') + '-service-lifecycle.json' });
const adapter = createPrivateBundlerAdapter(httpRpc(`http://127.0.0.1:${config.gateway.port}/rpc`, { headers: { authorization: `Bearer ${env[config.authTokenEnv]}` }, timeoutMs: 55000 }));
const allFrames = (frame: any): any[] => [frame, ...(frame.calls ?? []).flatMap(allFrames)];
try {
  for (const item of cases) {
    const { request, operation, call, id } = item;
    let record = output.records.find((r: any) => r.id === id);
    if (record?.status === 'included-policy-rejection-and-verified') continue;
    if (!record) { record = { id, profile: request.profileDetails.name, hash: request.userOperationHash, status: 'prepared' }; output.records.push(record); save(); }
    const context = { chainId, entryPoint, operation };
    const snapshot = async (blockNumber: bigint) => {
      const account = operation.sender, details = request.profileDetails;
      const code = await client.getCode({ address: account, blockNumber });
      const nonce = await client.readContract({ address: entryPoint, abi: entryPoint07Abi, functionName: 'getNonce', args: [account, 0n], blockNumber });
      const deposit = await client.readContract({ address: entryPoint, abi: entryPoint07Abi, functionName: 'balanceOf', args: [account], blockNumber });
      const balance = await client.getBalance({ address: account, blockNumber });
      const root = await client.readContract({ address: account, abi: find('Kernel').abi as Abi, functionName: 'rootValidator', blockNumber });
      const validation = await client.readContract({ address: account, abi: find('Kernel').abi as Abi, functionName: 'validationConfig', args: [root], blockNumber });
      const policyCode = await client.getCode({ address: details.policy, blockNumber }); assert.equal(keccak256(policyCode!), details.policyCodeHash);
      assert.ok(matchesRuntime((await client.getCode({ address: details.hook, blockNumber }))!, find('RestrictedExecutionHook')));
      const configuration = await client.readContract({ address: details.hook, abi: find('RestrictedExecutionHook').abi as Abi, functionName: 'configuration', blockNumber }); assert.equal(configuration, details.policyConfig);
      const immutableFields: Record<string, unknown> = {};
      for (const [field, expected] of [['entryPoint', entryPoint], ['policy', details.policy], ['policyCodeHash', details.policyCodeHash], ['configHash', keccak256(details.policyConfig)]] as const) {
        const actual = await client.readContract({ address: details.hook, abi: find('RestrictedExecutionHook').abi as Abi, functionName: field, blockNumber });
        assert.equal(String(actual).toLowerCase(), expected.toLowerCase()); immutableFields[field] = actual;
      }
      assert.equal(await client.readContract({ address: details.policy, abi: find('ICallPolicy').abi as Abi, functionName: 'checkCall', args: [account, call.target, call.value, call.data, configuration], blockNumber }), false);
      return { blockNumber, code, nonce, deposit, balance, root, validation, configuration, immutableFields, policyCodeHash: keccak256(policyCode!) };
    };
    if (!record.submission) {
      config.policy = structuredClone(original.policy); writeFileSync(configPath, json(config)); await service.reload();
      const before = await snapshot(await client.getBlockNumber({ cacheTime: 0 })); assert.equal(before.nonce, operation.nonce); record.before = before; save();
      await assert.rejects(adapter.submit(context), /denied by admission/i);
      record.admissionRejectedBeforeReplacement = true;
      config.policy = { kind: 'open', revision: `policy-rejection-open-${request.profileDetails.name}`, paymasters: [] };
      writeFileSync(configPath, json(config)); await service.reload();
      record.admissionConfigurationChangedWithoutAccountChange = true; save();
      // Mutate S's low byte in the ABI head, retaining canonical header padding.
      const bad = { ...operation, signature: `${operation.signature.slice(0, 130)}${(parseInt(operation.signature.slice(130, 132), 16) ^ 1).toString(16).padStart(2, '0')}${operation.signature.slice(132)}` as Hex };
      await assert.rejects(adapter.submit({ ...context, operation: bad }), (error: unknown) => {
        assert.ok(error instanceof RpcError);
        assert.match(error.message, /signature|AA24|simulateValidation reverted or returned no result/i);
        record.corruptedSignatureAdmissionResult = { code: error.code, message: error.message };
        return true;
      });
      // Strict simulation can report an outer revert without preserving AA24 in
      // its message. Independently distinguish signature failure from a policy
      // failure at the deployed validator, using the same account and block.
      const validatorAbi = find('PreparedTableValidator').abi as Abi;
      for (const [candidate, expected] of [[operation, 0n], [bad, 1n]] as const) {
        const data = encodeFunctionData({ abi: validatorAbi, functionName: 'validateUserOp', args: [packOperation(candidate), request.userOperationHash] });
        const result = await rpc('eth_call', [{ from: operation.sender, to: request.validator, data }, toHex(before.blockNumber)]) as Hex;
        assert.equal(decodeFunctionResult({ abi: validatorAbi, functionName: 'validateUserOp', data: result }), expected);
      }
      record.deployedValidatorAcceptedOriginalAndRejectedCorruption = true;
      record.invalidSignatureRejectedAfterReplacement = true; save();
      record.status = 'broadcast-result-unknown'; save();
      record.submission = await adapter.submit(context); record.status = 'submitted'; save();
    }
    let included = await adapter.status(context, record.submission);
    for (let attempt = 0; included.status === 'pending' && attempt < 12; attempt++) { await new Promise((resolve) => setTimeout(resolve, 4000)); included = await adapter.status(context, record.submission); }
    assert.equal(included.status, 'execution-reverted'); assert.ok(included.transactionHash);
    const receipt = await canonicalReceipt(client, included.transactionHash), checked = inclusionFromReceipt(context, receipt);
    assert.equal(receipt.status, 'success'); assert.equal(checked.status, 'execution-reverted');
    record.inclusion = checked; save();
    const after = await snapshot(receipt.blockNumber);
    assert.equal(after.nonce, operation.nonce + 1n); assert.equal(BigInt(record.before.balance), after.balance);
    assert.equal(BigInt(record.before.deposit) - after.deposit, checked.actualGasCost);
    for (const key of ['code', 'root', 'validation', 'configuration', 'immutableFields', 'policyCodeHash'] as const) assert.equal(json(record.before[key]), json(after[key]));
    const trace = await rpc('debug_traceTransaction', [receipt.transactionHash, { tracer: 'callTracer' }]), frames = allFrames(trace);
    const fromAccount = frames.filter((f) => f.from?.toLowerCase() === operation.sender.toLowerCase());
    assert.ok(!fromAccount.some((f) => f.type === 'CALL' && f.to?.toLowerCase() === call.target.toLowerCase()), 'Prohibited target must not be called');
    const validatorSelector = encodeFunctionData({ abi: find('PreparedTableValidator').abi as Abi, functionName: 'validateUserOp', args: [packOperation(operation), request.userOperationHash] }).slice(0, 10);
    const verified = fromAccount.find((f) => f.to?.toLowerCase() === request.validator.toLowerCase() && f.input?.startsWith(validatorSelector));
    assert.ok(verified && !verified.error); assert.equal(BigInt(verified.output), 0n);
    const hook = fromAccount.find((f) => f.to?.toLowerCase() === request.profileDetails.hook.toLowerCase() && f.error);
    assert.ok(hook); assert.equal(hook.output, encodeErrorResult({ abi: find('RestrictedExecutionHook').abi as Abi, errorName: 'RestrictedExecution' }));
    record.after = after; record.trace = trace; record.status = 'included-policy-rejection-and-verified'; record.validatorAcceptedSuppliedSignature = true;
    record.immutableHookRejectedBeforeProhibitedCall = true; record.gas = { transaction: receipt.gasUsed, validatorFrame: BigInt(verified.gasUsed) }; save();
    console.log(json({ id, profile: record.profile, status: record.status, transactionHash: receipt.transactionHash, actualGasCost: checked.actualGasCost }));
  }
  output.allRequestedCasesPassed = cases.every(({ id }) => output.records.some((r: any) => r.id === id && r.status === 'included-policy-rejection-and-verified')); save();
} catch (error) {
  output.failure = { at: new Date().toISOString(), message: String(error).replace(/https?:\/\/\S+|0x[0-9a-fA-F]{64,}/g, '[withheld]').slice(0, 600) }; save(); throw error;
} finally { await service.stop(); }
console.log(json({ file, allRequestedCasesPassed: output.allRequestedCasesPassed }));
