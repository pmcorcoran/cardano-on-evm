import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { decodeErrorResult, decodeFunctionResult, encodeFunctionResult, toFunctionSelector, toHex } from 'viem';
import { entryPoint07Abi } from 'viem/account-abstraction';
import { patchedText } from '../src/patches.mjs';

const pin = JSON.parse(readFileSync(new URL('../upstream.json', import.meta.url), 'utf8'));
const workerRoot = new URL(process.env.ALTO_TEST_WORKER === 'source' ? `../.local/alto-${pin.commit}/src/esm/` : '../node_modules/@pimlico/alto/esm/', import.meta.url);
const fixture = JSON.parse(readFileSync(new URL('fixtures/strict-validation.json', import.meta.url), 'utf8'));
let SafeValidator, pimlicoSimulationsAbi;
let finished = false;
after(() => { finished = true; console.log(JSON.stringify({ strictParserChecksCompleted: true, worker: process.env.ALTO_TEST_WORKER === 'source' ? 'source' : 'package' })); });
process.on('exit', () => assert.equal(finished, true, 'Strict worker tests exited before their completion hook'));
before(async () => {
  [{ SafeValidator }, { pimlicoSimulationsAbi }] = await Promise.all([
    import(new URL('rpc/validation/SafeValidator.js', workerRoot).href),
    import(new URL('types/contracts/PimlicoSimulations.js', workerRoot).href),
  ]);
  assert.equal(fixture.testData, true);
  assert.equal(fixture.provenance.commit, pin.commit);
  assert.equal(fixture.provenance.simulationAbiSha256, createHash('sha256').update(JSON.stringify(pimlicoSimulationsAbi)).digest('hex'));
});
for (const field of ['nonce', 'verificationGasLimit', 'callGasLimit', 'preVerificationGas', 'maxFeePerGas', 'maxPriorityFeePerGas']) fixture.operation[field] = BigInt(fixture.operation[field]);
function validator(trace) {
  const instance = Object.create(SafeValidator.prototype);
  instance.config = { publicClient: { request: async () => structuredClone(trace) }, entrypointSimulationContractV7: fixture.simulation, pimlicoSimulationContract: fixture.pimlico };
  instance.logger = { info() {}, debug() {} };
  instance.getCodeHashes = async (addresses) => ({ addresses, hash: '0x' });
  return instance;
}
const args = () => ({ userOp: fixture.operation, queuedUserOps: [], entryPoint: fixture.entryPoint });
test('pinned strict worker decodes the generated outer result despite a nested DelegateAndRevert', async () => {
  assert.equal(decodeErrorResult({ abi: entryPoint07Abi, data: fixture.trace.calls.at(-1).data }).errorName, 'DelegateAndRevert');
  const result = await validator(fixture.trace).getValidationResult07(args());
  assert.equal(result.returnInfo.accountSigFailed, false);
  assert.equal(result.returnInfo.preOpGas, 420000n);
  assert.deepEqual(new Set(result.referencedContracts.addresses), new Set([fixture.operation.sender, fixture.contracts.factory, fixture.contracts.implementation, fixture.contracts.validator, fixture.contracts.table]));
  assert.deepEqual(result.storageMap[fixture.operation.sender], fixture.trace.callsFromEntryPoint[0].access[fixture.operation.sender].reads);
});
test('the real worker parser rejects banned opcodes, foreign storage, and undeployed references', async () => {
  const banned = structuredClone(fixture.trace);
  const account = banned.callsFromEntryPoint.find((level) => level.topLevelTargetAddress === fixture.operation.sender.toLowerCase() && Object.keys(level.opcodes).length);
  assert.ok(account); account.opcodes.ORIGIN = 1;
  await assert.rejects(validator(banned).getValidationResult07(args()), /banned opcode: ORIGIN/);
  for (const writes of [false, true]) {
    const storage = structuredClone(fixture.trace);
    const slot = toHex(99n, { size: 32 });
    storage.callsFromEntryPoint[1].access[fixture.contracts.table] = { reads: { [slot]: toHex(0n, { size: 32 }) }, writes: writes ? { [slot]: 1 } : {} };
    await assert.rejects(validator(storage).getValidationResult07(args()), /unstaked account accessed|account has forbidden/);
  }
  const missingCode = structuredClone(fixture.trace);
  missingCode.callsFromEntryPoint[1].contractSize[fixture.contracts.table].contractSize = 0;
  await assert.rejects(validator(missingCode).getValidationResult07(args()), /accesses un-deployed contract/);
  await assert.rejects(validator(fixture.trace).getValidationResult07({ ...args(), codeHashes: { addresses: [fixture.contracts.table], hash: '0x01' } }), /code hashes mismatch/);
});
test('nested calls cannot access EntryPoint methods or transfer value during validation', async () => {
  const forbidden = structuredClone(fixture.trace);
  forbidden.calls.splice(11, 0, { type: 'CALL', from: fixture.operation.sender, to: fixture.entryPoint, method: toFunctionSelector('getNonce(address,uint192)'), value: '0', gas: 10000 }, { type: 'RETURN', data: toHex(0n, { size: 32 }), gasUsed: 100 });
  await assert.rejects(validator(forbidden).getValidationResult07(args()), /illegal call into EntryPoint during validation/);
  const value = structuredClone(fixture.trace);
  value.calls.find((call) => call.to === fixture.contracts.validator).value = '1';
  await assert.rejects(validator(value).getValidationResult07(args()), /CALL with value/);
});
test('outer reverts, missing results and signature-failure validation data remain rejected', async () => {
  const missing = structuredClone(fixture.trace); delete missing.output;
  for (const changed of [{ ...fixture.trace, error: 'execution reverted' }, { ...fixture.trace, output: '0x' }, missing]) {
    await assert.rejects(validator(changed).getValidationResult07(args()), /reverted or returned no result/);
  }
  for (const [field, data, expected] of [
    ['accountValidationData', 1n, /Invalid UserOp signature/],
    ['paymasterValidationData', 1n, /Invalid UserOp paymasterData/],
    ['accountValidationData', 1n << 160n, /expires too soon/],
    ['accountValidationData', ((1n << 48n) - 1n) << 208n, /not valid yet/],
  ]) {
    const result = decodeFunctionResult({ abi: pimlicoSimulationsAbi, functionName: 'simulateValidation', data: fixture.trace.output });
    result.returnInfo[field] = data;
    const changed = { ...fixture.trace, output: encodeFunctionResult({ abi: pimlicoSimulationsAbi, functionName: 'simulateValidation', result }) };
    await assert.rejects(validator(changed).getValidationResult07(args()), expected);
  }
});
test('worker patches are idempotent and reject unrelated or partial changes', () => {
  const original = 'upstream alpha beta';
  const patch = { installedSha256: createHash('sha256').update(original).digest('hex'), replacements: [{ find: 'alpha', replace: 'alpha fixed' }, { find: 'beta', replace: 'beta fixed' }] };
  const changed = patchedText(original, patch).changed;
  assert.equal(patchedText(changed, patch).changed, changed);
  assert.throws(() => patchedText(`${changed}!`, patch));
  assert.throws(() => patchedText(original.replace('alpha', 'alpha fixed'), patch));
});
