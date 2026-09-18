import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { concatHex, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, stringToHex, toHex } from 'viem';
import { validateConfig, credentials } from '../src/config.mjs';
import { decodeExecution, admitOperation, validatePolicy } from '../src/admission.mjs';
import { startGateway } from '../src/gateway.mjs';

const example = JSON.parse(await readFile(new URL('../config/base-sepolia.example.json', import.meta.url), 'utf8'));
const sender = '0x1111111111111111111111111111111111111111';
const target = example.policy.rules[0].target;
const abi = parseAbi(['function execute(bytes32 mode, bytes executionCalldata) payable']);
const increment = encodeFunctionData({ abi: parseAbi(['function increment(uint256 by)']), functionName: 'increment', args: [1n] });
const execute = (to = target, data = increment, value = 0n) => encodeFunctionData({ abi, functionName: 'execute', args: [toHex(0n, { size: 32 }), concatHex([to, toHex(value, { size: 32 }), data])] });
const op = { sender, nonce: '0x0', callData: execute(), signature: '0x', callGasLimit: '0x3d090', verificationGasLimit: '0x7a120', preVerificationGas: '0x186a0', maxFeePerGas: '0x2faf080', maxPriorityFeePerGas: '0x1e8480' };
const config = () => validateConfig(structuredClone(example));
test('configuration makes authentication, gas bounds and simulation choices explicit', () => {
  assert.equal(example.policy.rules[0].selectors[0], increment.slice(0, 10));
  const c = config();
  assert.equal(c.workerBuild, 'package');
  assert.equal(validateConfig({ ...c, workerBuild: 'source' }).workerBuild, 'source');
  assert.throws(() => validateConfig({ ...c, workerBuild: '/untrusted/worker.js' }));
  for (const field of ['dangerous-skip-user-operation-validation', 'enable-debug-endpoints', 'enable-cors', 'deploy-simulations-contract', 'refilling-wallets']) { const bad = structuredClone(c); bad.worker[field] = true; assert.throws(() => validateConfig(bad)); }
  const deviation = structuredClone(c); deviation.worker['safe-mode'] = false;
  assert.throws(() => validateConfig(deviation)); deviation.admissionDeviationReason = 'Local Anvil does not implement the required JS debug tracer'; assert.equal(validateConfig(deviation).worker['safe-mode'], false);
  assert.throws(() => credentials(c, {}));
  assert.throws(() => credentials(c, { BASE_SEPOLIA_RPC_URL: 'https://example.com', BUNDLER_EXECUTOR_PRIVATE_KEY: `0x${'11'.repeat(32)}`, BUNDLER_AUTH_TOKEN: 'weak' }));
});
test('admission checks complete canonical batches, selectors, value, fees and optional sponsors', () => {
  const c = config(); assert.equal(admitOperation(op, c.entryPoint, c).revision, 'counter-v1');
  const prefix = keccak256(stringToHex('executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)')).slice(0, 10);
  assert.equal(decodeExecution(concatHex([prefix, op.callData]))[0].target, target.toLowerCase());
  for (const mutation of [{ callData: execute(sender) }, { callData: execute(target, '0x') }, { callData: execute(target, '0x12345678') }, { callData: execute(target, increment, 1n) }, { callData: `${op.callData}00` }, { verificationGasLimit: '0x7a121' }, { maxFeePerGas: '0x2faf081' }, { paymaster: sender }, { nonce: '0x00' }, { maxPriorityFeePerGas: '0x3faf080' }]) assert.throws(() => admitOperation({ ...op, ...mutation }, c.entryPoint, c));
  const batch = encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] }], [[{ target, value: 0n, data: increment }, { target: sender, value: 0n, data: increment }]]);
  const data = encodeFunctionData({ abi, functionName: 'execute', args: [`0x01${'00'.repeat(31)}`, batch] });
  assert.throws(() => admitOperation({ ...op, callData: data }, c.entryPoint, c));
  assert.throws(() => validatePolicy({ kind: 'allowlist', revision: 'bad', rules: [] }));
});
test('HTTP authentication, method bounds, admission replacement and failed reload preserve authority boundaries', async () => {
  const c = config(); c.gateway.port = 0;
  const token = 'test-only-gateway-token-00000000000000000000';
  const forwarded = [], logs = [];
  const gateway = await startGateway({ config: c, token, log: (line) => logs.push(line), forward: async (request) => { forwarded.push(request); return { jsonrpc: '2.0', id: request.id, result: `0x${'aa'.repeat(32)}` }; } });
  const url = `http://127.0.0.1:${gateway.address.port}/rpc`;
  const request = (operation = op) => ({ jsonrpc: '2.0', id: 1, method: 'eth_sendUserOperation', params: [operation, c.entryPoint] });
  const send = (body, auth = token) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  try {
    assert.equal((await send(request(), 'wrong')).status, 401); assert.equal(forwarded.length, 0);
    assert.ok((await (await send(request())).json()).result); assert.equal(forwarded.length, 1);
    const prohibited = { ...op, callData: execute(sender) };
    assert.ok((await (await send(request(prohibited))).json()).error); assert.equal(forwarded.length, 1);
    const changed = structuredClone(c); changed.policy = { kind: 'open', revision: 'replace-v2', paymasters: [] };
    gateway.reload(changed);
    assert.ok((await (await send(request(prohibited))).json()).result); assert.deepEqual(forwarded[1].params[0], prohibited, 'Gateway forwards unchanged authorization; it does not sign or alter it');
    const invalid = structuredClone(changed); invalid.chainId = 1;
    assert.throws(() => gateway.reload(invalid));
    assert.throws(() => gateway.reload({ ...changed, workerBuild: 'source' }));
    const metrics = await (await fetch(url.replace('/rpc', '/metrics'), { headers: { authorization: `Bearer ${token}` } })).json();
    assert.equal(metrics.policyRevision, 'replace-v2'); assert.equal(metrics.reloads, 1);
    assert.ok((await (await send([request()])).json()).error);
    assert.ok((await (await send({ ...request(), method: 'debug_bundler_clearState' })).json()).error);
    assert.equal((await (await send('{')).json()).error.code, -32700);
    const beforeInvalid = forwarded.length;
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json\ta', authorization: `Bearer ${token}` }, body: JSON.stringify(request()) })).status, 400);
    for (const body of ['"10"', '10', 'null']) assert.ok((await (await send(body)).json()).error);
    assert.equal(forwarded.length, beforeInvalid, 'Ambiguous content types and root primitives never reach the HTTP worker');
    assert.equal(JSON.stringify(logs).includes(token), false);
    assert.equal(JSON.stringify(logs).includes(op.callData), false);
  } finally { await gateway.stop(); }
});
