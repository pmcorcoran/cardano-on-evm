import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createPublicClient, http, encodeFunctionData, decodeFunctionData, keccak256, toHex, type Abi, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { entryPoint07Abi } from 'viem/account-abstraction';
import { operationFromJson, operationHash, packOperation, validatorSignature } from '../../packages/protocol/src/index.js';
import { httpRpc, inclusionFromReceipt } from '../../packages/submission/src/index.js';
import { artifacts, json } from '../lib/live-context.js';
import { canonicalReceipt } from '../lib/canonical-receipt.js';
import { checkLiveRequest } from '../lib/live-request.js';
import { fromHex, verifyCip8Signature } from '../../packages/wallet/src/index.js';
import { releaseEvidenceOutput } from '../lib/release-evidence.js';
import assert from 'node:assert/strict';

const { values } = parseArgs({ options: { request: { type: 'string' }, result: { type: 'string' }, out: { type: 'string' } } });
if (!values.request || !values.result || !values.out) throw new Error('--request, --result and --out are required');
const request = JSON.parse(readFileSync(values.request, 'utf8'));
const result = JSON.parse(readFileSync(values.result, 'utf8'));
checkLiveRequest(request);
if (result.status !== 'included-and-verified') throw new Error('Verified live execution required');
if (result.requestId !== request.id || result.chainId !== request.chainId || result.entryPoint.toLowerCase() !== request.entryPoint.toLowerCase() || result.userOperationHash !== request.userOperationHash || result.mode !== request.mode) throw new Error('Measurement result differs from the requested operation');
const captured = JSON.parse(readFileSync(result.signatureFile, 'utf8'));
const operation = operationFromJson(captured.operation);
const signed = verifyCip8Signature(captured.signed, { address: request.cardanoAddress, network: request.cardanoNetwork, payload: fromHex(request.payloadHex) });
if (operationHash(operation, request.chainId, request.entryPoint) !== request.userOperationHash || operation.signature !== validatorSignature(signed) || toHex(signed.publicKey).toLowerCase() !== request.publicKey.toLowerCase() || keccak256(signed.protectedHeaders) !== request.protectedHeaderHash) throw new Error('Measurement authorization differs from the requested operation');
const outputFile = releaseEvidenceOutput(values.out, [values.request, values.result, result.signatureFile]);
const client = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org') });
if (await client.getChainId() !== 84532) throw new Error('Expected Base Sepolia');
const receipt = await canonicalReceipt(client, result.transactionHash);
const inclusion = inclusionFromReceipt({ chainId: request.chainId, entryPoint: request.entryPoint, operation }, receipt);
assert.equal(inclusion.status, 'included');
const rpc = httpRpc(process.env.TRACE_RPC_URL ?? process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org');
const output: any = { kind: 'live-full-kernel-gas-measurement', measuredAt: new Date().toISOString(), chainId: 84532, transactionHash: receipt.transactionHash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber, mode: request.mode, sender: operation.sender, nonce: operation.nonce, verificationGasLimit: operation.verificationGasLimit, callGasLimit: operation.callGasLimit, preVerificationGas: operation.preVerificationGas, transactionGas: receipt.gasUsed, entryPointActualGasUsed: inclusion.actualGasUsed, entryPointActualGasCost: inclusion.actualGasCost, isolatedVerifierEstimate: false, traceStatus: 'pending' };
const allFrames = (frame: any): any[] => [frame, ...(frame.calls ?? []).flatMap(allFrames)];
try {
  const trace = await rpc('debug_traceTransaction', [receipt.transactionHash, { tracer: 'callTracer' }]);
  const all = allFrames(trace);
  const find = artifacts(); const packed = packOperation(operation);
  const accountSelector = encodeFunctionData({ abi: find('Kernel').abi as Abi, functionName: 'validateUserOp', args: [packed, request.userOperationHash, 0n] }).slice(0, 10);
  const validatorSelector = encodeFunctionData({ abi: find('PreparedTableValidator').abi as Abi, functionName: 'validateUserOp', args: [packed, request.userOperationHash] }).slice(0, 10);
  const accountFrames = all.filter((f) => f.to?.toLowerCase() === operation.sender.toLowerCase() && f.input?.startsWith(accountSelector));
  if (accountFrames.length !== 1) throw new Error('Trace did not identify exactly one account validation frame');
  const accountCall = decodeFunctionData({ abi: find('Kernel').abi as Abi, data: accountFrames[0].input });
  assert.deepEqual(accountCall.args?.[0], packed, 'Account validation trace must contain the measured operation');
  assert.equal(accountCall.args?.[1], request.userOperationHash);
  const validatorInput = encodeFunctionData({ abi: find('PreparedTableValidator').abi as Abi, functionName: 'validateUserOp', args: [packed, request.userOperationHash] });
  const validators = allFrames(accountFrames[0]).filter((f) => f.to?.toLowerCase() === request.validator.toLowerCase() && f.input?.toLowerCase() === validatorInput.toLowerCase());
  if (validators.length !== 1) throw new Error('Trace did not identify exactly one Cardano verification frame');
  assert.ok(!accountFrames[0].error && !validators[0].error); assert.equal(BigInt(validators[0].output), 0n);
  let factoryGas = 0n;
  if (operation.factory) {
    const factories = all.filter((f) => f.to?.toLowerCase() === operation.factory!.toLowerCase() && f.input?.toLowerCase() === operation.factoryData?.toLowerCase());
    if (factories.length !== 1) throw new Error('Trace did not identify exactly one factory frame');
    factoryGas = BigInt(factories[0].gasUsed);
  }
  output.traceStatus = 'measured'; output.validatorFrameGas = BigInt(validators[0].gasUsed); output.accountValidationFrameGas = BigInt(accountFrames[0].gasUsed); output.accountCreationFrameGas = factoryGas;
  if (request.profile === 'restricted') {
    const hooks = all.filter((f) => f.to?.toLowerCase() === request.profileDetails.hook.toLowerCase());
    const policies = all.filter((f) => f.to?.toLowerCase() === request.profileDetails.policy.toLowerCase());
    output.hookCalls = hooks.map((f) => ({ selector: f.input.slice(0, 10), gas: BigInt(f.gasUsed), includesNestedCalls: true }));
    output.policyCalls = policies.map((f) => ({ selector: f.input.slice(0, 10), gas: BigInt(f.gasUsed) }));
  }
} catch (error) {
  output.traceStatus = 'unavailable'; output.traceObstacle = error instanceof Error ? error.message : 'Trace unavailable';
}
mkdirSync(dirname(values.out), { recursive: true });
writeFileSync(outputFile, json(output), { flag: 'wx' }); console.log(json(output));
