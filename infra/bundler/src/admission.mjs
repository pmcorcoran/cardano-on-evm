import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, stringToHex } from 'viem';

const executeAbi = parseAbi(['function execute(bytes32 mode, bytes executionCalldata) payable']);
const prefix = keccak256(stringToHex('executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)')).slice(0, 10);
const batchType = [{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] }];
const address = (value) => getAddress(value).toLowerCase();
export class AdmissionError extends Error {
  constructor(message, code = -32500) { super(message); this.code = code; }
}
const reject = (message) => { throw new AdmissionError(message); };
export function quantity(value, field, optional = false) {
  if (value === undefined && optional) return 0n;
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value) || value.length > 66) reject(`Invalid ${field}`);
  return BigInt(value);
}
export function decodeExecution(data) {
  if (typeof data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(data) || data.length > 32770) reject('Invalid callData');
  data = data.toLowerCase();
  if (data.startsWith(prefix)) data = `0x${data.slice(10)}`;
  try {
    const { args } = decodeFunctionData({ abi: executeAbi, data });
    if (encodeFunctionData({ abi: executeAbi, functionName: 'execute', args }) !== data) reject('Noncanonical CALL encoding');
    const [mode, encoded] = args;
    if (mode === `0x${'00'.repeat(32)}`) {
      if (encoded.length < 106) reject('Truncated CALL');
      return [{ target: address(encoded.slice(0, 42)), value: BigInt(`0x${encoded.slice(42, 106)}`), data: `0x${encoded.slice(106)}` }];
    }
    if (mode !== `0x01${'00'.repeat(31)}`) reject('Unsupported execution mode');
    const [calls] = decodeAbiParameters(batchType, encoded);
    if (!calls.length || calls.length > 64 || encodeAbiParameters(batchType, [calls]) !== encoded) reject('Invalid canonical batch');
    return calls.map((call) => ({ ...call, target: address(call.target) }));
  } catch (error) {
    if (error instanceof AdmissionError) throw error;
    reject('Admission requires canonical Kernel CALL or batch');
  }
}
export function validatePolicy(policy) {
  if (!policy || !['open', 'allowlist'].includes(policy.kind) || typeof policy.revision !== 'string' || !/^[\w.-]{1,64}$/.test(policy.revision)) throw new Error('Invalid admission policy');
  const result = { kind: policy.kind, revision: policy.revision };
  for (const key of ['senders', 'factories', 'paymasters']) {
    if (policy[key] !== undefined) {
      if (!Array.isArray(policy[key]) || policy[key].length > 1024) throw new Error(`Invalid policy ${key}`);
      result[key] = [...new Set(policy[key].map(address))];
    }
  }
  if (policy.kind === 'allowlist') {
    if (!Array.isArray(policy.rules) || !policy.rules.length || policy.rules.length > 256) throw new Error('Supply admission rules');
    result.rules = policy.rules.map((rule) => {
      const target = address(rule.target);
      if (!Array.isArray(rule.selectors) || rule.selectors.length > 64 || rule.selectors.some((s) => !/^0x[0-9a-fA-F]{8}$/.test(s))) throw new Error('Invalid selectors');
      if (typeof rule.allowEmpty !== 'boolean' || typeof rule.maxValueWei !== 'string' || !/^(0|[1-9][0-9]*)$/.test(rule.maxValueWei) || rule.maxValueWei.length > 78) throw new Error('Invalid rule value/empty-data setting');
      return { target, selectors: rule.selectors.map((s) => s.toLowerCase()), allowEmpty: rule.allowEmpty, maxValueWei: rule.maxValueWei };
    });
    if (new Set(result.rules.map((r) => r.target)).size !== result.rules.length) throw new Error('Duplicate target rules');
  }
  return result;
}
export function admitOperation(op, entryPoint, config, estimate = false) {
  if (typeof entryPoint !== 'string' || address(entryPoint) !== address(config.entryPoint)) reject('Unsupported EntryPoint');
  if (!op || typeof op !== 'object' || Array.isArray(op)) reject('Invalid UserOperation');
  const sender = address(op.sender);
  const policy = config.policy, limits = config.limits;
  quantity(op.nonce, 'nonce');
  if (policy.senders && !policy.senders.includes(sender)) reject('Sender denied by admission');
  for (const [field, list] of [['factory', policy.factories], ['paymaster', policy.paymasters]]) {
    if (op[field] && list && !list.includes(address(op[field]))) reject(`${field} denied by admission`);
  }
  const verification = quantity(op.verificationGasLimit, 'verificationGasLimit', estimate);
  const call = quantity(op.callGasLimit, 'callGasLimit', estimate);
  const pre = quantity(op.preVerificationGas, 'preVerificationGas', estimate);
  const paymasterVerification = quantity(op.paymasterVerificationGasLimit, 'paymasterVerificationGasLimit', true);
  const paymasterPost = quantity(op.paymasterPostOpGasLimit, 'paymasterPostOpGasLimit', true);
  const total = verification + call + pre + paymasterVerification + paymasterPost;
  const fee = quantity(op.maxFeePerGas, 'maxFeePerGas', estimate);
  const priority = quantity(op.maxPriorityFeePerGas, 'maxPriorityFeePerGas', estimate);
  if (verification > BigInt(limits.verificationGas) || call > BigInt(limits.callGas) || total > BigInt(limits.totalGas)) reject('Operation gas cap exceeded');
  if (fee > BigInt(limits.maxFeePerGas) || priority > fee || total * fee > BigInt(limits.maxOperationCostWei)) reject('Operation fee cap exceeded');
  if (policy.kind === 'open') return { revision: policy.revision };
  for (const call of decodeExecution(op.callData)) {
    if (call.target === sender) reject('Self-call denied by admission');
    const rule = policy.rules.find((rule) => rule.target === call.target);
    if (!rule || call.value > BigInt(rule.maxValueWei)) reject('Target or value denied by admission');
    if (call.data === '0x') { if (!rule.allowEmpty) reject('Empty call denied by admission'); }
    else if (call.data.length < 10 || !rule.selectors.includes(call.data.slice(0, 10))) reject('Selector denied by admission');
  }
  return { revision: policy.revision };
}
