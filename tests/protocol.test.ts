import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex, type Hex } from 'viem';
import { encodeCalls, decodeCalls, operationFromJson, operationToJson, operationPayload, operationHash, packOperation, type Operation, type Call } from '../packages/protocol/src/index.js';

const ep = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const address = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const op: Operation = { sender: address, nonce: 0n, callData: encodeCalls([{ target: other, value: 2n, data: '0xabcd' }]), callGasLimit: 250_000n, verificationGasLimit: 500_000n, preVerificationGas: 100_000n, maxFeePerGas: 10_000_000n, maxPriorityFeePerGas: 1_000_000n, signature: '0x' };
test('call display is an exact canonical decoding of the authorized execution', () => {
  const calls: Call[] = [{ target: address, value: 12n, data: '0xabcd' as Hex }, { target: other, value: 0n, data: '0x' as Hex }];
  for (const selected of [calls.slice(0, 1), calls]) assert.deepEqual(decodeCalls(encodeCalls(selected)), selected);
  assert.throws(() => decodeCalls(`${encodeCalls(calls)}00`));
  assert.throws(() => encodeCalls([]));
  assert.throws(() => decodeCalls('0x1234'));
});
test('operation JSON preserves the v0.7 hash and excludes unsupported extension fields', () => {
  assert.deepEqual(operationFromJson(operationToJson(op)), op);
  for (const changed of [{ gas: '0x1' }, { eip7702Auth: '0x01' }, { nonce: '-1' }, { nonce: '01' }, { verificationGasLimit: (1n << 128n).toString() }, { factory: other }, { paymasterData: '0x' }, { maxPriorityFeePerGas: '100000001' }]) assert.throws(() => operationFromJson({ ...operationToJson(op), ...changed }));
  const packed = packOperation(op);
  assert.equal(packed.accountGasLimits, `0x${500_000n.toString(16).padStart(32, '0')}${250_000n.toString(16).padStart(32, '0')}`);
  assert.equal(packed.initCode, '0x');
});
test('every signed operation/context field changes authorization; signature does not', () => {
  const baseline = operationPayload(op, 84532, ep);
  const changed: Partial<Operation>[] = [
    { sender: other }, { nonce: 1n }, { callData: encodeCalls([{ target: other, value: 3n, data: '0xabcd' }]) },
    { factory: other, factoryData: '0x00' }, { callGasLimit: 250001n }, { verificationGasLimit: 500001n }, { preVerificationGas: 100001n },
    { maxFeePerGas: 10000001n }, { maxPriorityFeePerGas: 1000001n },
    { paymaster: other, paymasterData: '0xab', paymasterVerificationGasLimit: 10000n, paymasterPostOpGasLimit: 10000n },
  ];
  for (const mutation of changed) assert.notEqual(operationPayload({ ...op, ...mutation }, 84532, ep), baseline);
  assert.notEqual(operationPayload(op, 8453, ep), baseline);
  assert.notEqual(operationPayload(op, 84532, other), baseline);
  assert.notEqual(operationHash(op, 84532, ep), baseline);
  assert.equal(operationPayload({ ...op, signature: toHex(1n, { size: 32 }) }, 84532, ep), baseline);
});
