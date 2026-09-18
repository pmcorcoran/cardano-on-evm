import { concatHex, decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, stringToHex, toHex, type Address, type Hex } from 'viem';
import { getUserOperationHash, toPackedUserOperation, type UserOperation } from 'viem/account-abstraction';
import type { VerifiedCip8 } from '@cardano-on-evm/wallet';
export * from './identity.js';
export * from './profiles.js';

/** Kernel requires this selector prefix when its root has an execution hook. */
export const EXECUTE_USER_OP_SELECTOR = keccak256(stringToHex('executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)')).slice(0, 10) as Hex;
export const wrapRestrictedExecution = (execution: Hex): Hex => concatHex([EXECUTE_USER_OP_SELECTOR, execution]);
export function decodeRestrictedCalls(data: Hex): Call[] {
  if (data.slice(0, 10).toLowerCase() !== EXECUTE_USER_OP_SELECTOR) throw new Error('Restricted execution hook prefix required');
  return decodeCalls(`0x${data.slice(10)}`);
}

export type Operation = UserOperation<'0.7'>;
export const OPERATION_DOMAIN = keccak256(stringToHex('cardano-kernel:operation:v1'));
export const executeAbi = parseAbi(['function execute(bytes32 mode, bytes executionCalldata) payable']);
export interface Call { target: Address; value: bigint; data: Hex }
const executionArray = [{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'callData', type: 'bytes' }] }] as const;

export function encodeCalls(calls: readonly Call[]): Hex {
  if (calls.length === 0 || calls.length > 64) throw new Error('Supply 1..64 calls');
  const batch = calls.length > 1;
  const execution = batch
    ? encodeAbiParameters(executionArray, [calls.map((call) => ({ target: getAddress(call.target), value: call.value, callData: call.data }))])
    : concatHex([getAddress(calls[0]!.target), toHex(calls[0]!.value, { size: 32 }), calls[0]!.data]);
  return encodeFunctionData({ abi: executeAbi, functionName: 'execute', args: [batch ? `0x01${'00'.repeat(31)}` : toHex(0n, { size: 32 }), execution] });
}

export function decodeCalls(callData: Hex): Call[] {
  const { args } = decodeFunctionData({ abi: executeAbi, data: callData });
  const [mode, execution] = args;
  if (encodeFunctionData({ abi: executeAbi, functionName: 'execute', args }) !== callData.toLowerCase()) throw new Error('Noncanonical execute encoding');
  if (mode === toHex(0n, { size: 32 })) {
    if (execution.length < 106) throw new Error('Truncated single-call encoding');
    return [{ target: getAddress(execution.slice(0, 42)), value: BigInt(`0x${execution.slice(42, 106)}`), data: `0x${execution.slice(106)}` }];
  }
  if (mode !== `0x01${'00'.repeat(31)}`) throw new Error('Unsupported execution mode');
  const [calls] = decodeAbiParameters(executionArray, execution);
  if (calls.length === 0 || calls.length > 64) throw new Error('Invalid batch length');
  if (encodeAbiParameters(executionArray, [calls]) !== execution) throw new Error('Noncanonical batch encoding');
  return calls.map((call) => ({ target: getAddress(call.target), value: call.value, data: call.callData }));
}

export function operationHash(operation: Operation, chainId: number, entryPoint: Address): Hex {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('Invalid chain ID');
  return getUserOperationHash({ userOperation: operation, chainId, entryPointAddress: entryPoint, entryPointVersion: '0.7' });
}
export function operationPayload(operation: Operation, chainId: number, entryPoint: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [OPERATION_DOMAIN, operationHash(operation, chainId, entryPoint)]));
}
export function validatorSignature(verified: VerifiedCip8): Hex {
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes32' }, { type: 'bytes32' }], [toHex(verified.protectedHeaders), toHex(verified.signature.slice(0, 32)), toHex(verified.signature.slice(32))]);
}
export function packOperation(operation: Operation) { return toPackedUserOperation(operation); }

const numeric = ['nonce', 'callGasLimit', 'verificationGasLimit', 'preVerificationGas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'paymasterVerificationGasLimit', 'paymasterPostOpGasLimit'] as const;
const required = ['sender', 'nonce', 'callData', 'signature', 'callGasLimit', 'verificationGasLimit', 'preVerificationGas', 'maxFeePerGas', 'maxPriorityFeePerGas'] as const;
const allowed = new Set<string>([...required, ...numeric, 'factory', 'factoryData', 'paymaster', 'paymasterData']);
export function operationToJson(operation: Operation): Record<string, string> {
  return Object.fromEntries(Object.entries(operation).filter(([, value]) => value !== undefined).map(([name, value]) => [name, typeof value === 'bigint' ? value.toString() : String(value)]));
}
export function operationFromJson(value: unknown): Operation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an operation object');
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((name) => !allowed.has(name)) || required.some((name) => object[name] === undefined)) throw new Error('Unsupported or missing operation fields');
  const parsed: Record<string, string | bigint> = {};
  for (const [name, item] of Object.entries(object)) {
    if (typeof item !== 'string') throw new Error('Operation JSON fields must be strings');
    if ((numeric as readonly string[]).includes(name)) {
      if (!/^(0|[1-9][0-9]*|0x[0-9a-f]+)$/.test(item)) throw new Error('Invalid operation integer');
      const number = BigInt(item); const bits = ['nonce', 'preVerificationGas'].includes(name) ? 256n : 128n;
      if (number < 0n || number >= (1n << bits)) throw new Error('Operation integer out of range');
      parsed[name] = number;
    } else if (['sender', 'factory', 'paymaster'].includes(name)) parsed[name] = getAddress(item);
    else {
      if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(item) || item.length > 32770) throw new Error('Invalid operation bytes');
      parsed[name] = item.toLowerCase();
    }
  }
  if (Boolean(parsed.factory) !== (parsed.factoryData !== undefined)) throw new Error('Factory and data must be supplied together');
  if (parsed.paymaster && (parsed.paymasterVerificationGasLimit === undefined || parsed.paymasterPostOpGasLimit === undefined || parsed.paymasterData === undefined)) throw new Error('Incomplete paymaster fields');
  if (!parsed.paymaster && ['paymasterData', 'paymasterVerificationGasLimit', 'paymasterPostOpGasLimit'].some((name) => parsed[name] !== undefined)) throw new Error('Unexpected paymaster fields');
  if (BigInt(parsed.maxPriorityFeePerGas!) > BigInt(parsed.maxFeePerGas!)) throw new Error('Priority fee exceeds maximum fee');
  return parsed as unknown as Operation;
}
