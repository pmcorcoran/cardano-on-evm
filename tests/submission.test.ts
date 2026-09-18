import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, toHex, type Hex } from 'viem';
import { entryPoint07Abi } from 'viem/account-abstraction';
import { encodeCalls, operationHash, packOperation, type Operation } from '../packages/protocol/src/index.js';
import { createDirectAdapter, createPrivateBundlerAdapter, createPublicBundlerAdapter, httpRpc, inclusionFromReceipt, RpcError, rpcOperation, type Rpc, type OperationContext } from '../packages/submission/src/index.js';

const ep = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const sender = '0x1111111111111111111111111111111111111111';
const submitter = '0x2222222222222222222222222222222222222222';
const operation: Operation = { sender, nonce: 3n, callData: encodeCalls([{ target: submitter, value: 0n, data: '0x' }]), callGasLimit: 250000n, verificationGasLimit: 500000n, preVerificationGas: 100000n, maxFeePerGas: 50000000n, maxPriorityFeePerGas: 2000000n, signature: '0xabcd' };
const context: OperationContext = { chainId: 84532, entryPoint: ep, operation }; const hash = operationHash(operation, 84532, ep); const tx = toHex(123n, { size: 32 });
function receipt(success = true, eventHash: Hex = hash) {
  return { transactionHash: tx, status: '0x1', logs: [{ address: ep, topics: encodeEventTopics({ abi: entryPoint07Abi, eventName: 'UserOperationEvent', args: { userOpHash: eventHash, sender, paymaster: '0x0000000000000000000000000000000000000000' } }), data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [operation.nonce, success, 9876n, 5432n]) }] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function changeContext(input: OperationContext) {
  input.chainId = 1; input.entryPoint = sender;
  input.operation.nonce++; input.operation.callData = '0x'; input.operation.maxFeePerGas++;
}
test('receipt handling distinguishes execution failure from outer transaction success', () => {
  assert.equal(inclusionFromReceipt(context, receipt()).status, 'included');
  assert.equal(inclusionFromReceipt(context, receipt(false)).status, 'execution-reverted');
  assert.equal(inclusionFromReceipt(context, { ...receipt(), status: '0x0' }).status, 'transaction-reverted');
  assert.equal(inclusionFromReceipt(context, null).status, 'pending');
  assert.throws(() => inclusionFromReceipt(context, receipt(true, tx)), /matching EntryPoint/);
  assert.throws(() => inclusionFromReceipt(context, { ...receipt(), logs: [...receipt().logs, ...receipt().logs] }), /exactly one/);
});
test('public and private adapters preserve signed operations and reject dishonest hashes/receipts', async () => {
  for (const create of [createPublicBundlerAdapter, createPrivateBundlerAdapter]) {
    let sent: unknown; let wrongHash = false; let inconsistentSuccess = false;
    const rpc: Rpc = async (method, params) => {
      if (method === 'eth_supportedEntryPoints') return [ep];
      if (method === 'eth_sendUserOperation') { sent = params; return wrongHash ? tx : hash; }
      if (method === 'eth_getUserOperationReceipt') return { userOpHash: hash, success: !inconsistentSuccess, receipt: receipt() };
      throw new Error('Unexpected method');
    };
    const adapter = create(rpc); const submission = await adapter.submit(context);
    assert.deepEqual(sent, [rpcOperation(operation), ep]);
    assert.equal((await adapter.status(context, submission)).status, 'included');
    await assert.rejects(adapter.status({ ...context, chainId: 8453 }, submission), /context changed/);
    inconsistentSuccess = true; await assert.rejects(adapter.status(context, submission), /status mismatch/);
    wrongHash = true; await assert.rejects(adapter.submit(context), /unexpected operation hash/);
  }
});
test('direct adapter uses ordinary RPC and cannot submit before context and validation checks', async () => {
  const methods: string[] = []; let sends = 0; let wrongChain = false; let invalid = false;
  const rpc: Rpc = async (method, params) => {
    methods.push(method);
    if (method === 'eth_chainId') return wrongChain ? '0x1' : toHex(84532);
    if (method === 'eth_getTransactionReceipt') return receipt();
    if (method === 'eth_call') {
      const input = params[0] as { from?: string };
      if (!input.from) return hash;
      if (invalid) throw new RpcError(-32500, 'AA24 signature error'); return '0x';
    }
    throw new Error('A bundler method was unexpectedly required');
  };
  const adapter = createDirectAdapter({ rpc, submitter, sendTransaction: async ({ to, data }) => { assert.equal(to, ep); assert.ok(data.startsWith('0x765e827f')); sends++; return tx; } });
  const submitted = await adapter.submit(context); assert.equal((await adapter.status(context, submitted)).status, 'included');
  wrongChain = true; await assert.rejects(adapter.submit(context), /chain mismatch/);
  wrongChain = false; invalid = true; await assert.rejects(adapter.submit(context), /AA24/);
  assert.equal(sends, 1); assert.ok(methods.every((method) => ['eth_chainId', 'eth_call', 'eth_getTransactionReceipt'].includes(method)));
});
test('public and private submissions retain the original intent while EntryPoint discovery is pending', async () => {
  for (const create of [createPublicBundlerAdapter, createPrivateBundlerAdapter]) {
    const ready = deferred<unknown>(); let sent: readonly unknown[] | undefined;
    const input = structuredClone(context);
    const adapter = create(async (method, params) => {
      if (method === 'eth_supportedEntryPoints') return ready.promise;
      assert.equal(method, 'eth_sendUserOperation'); sent = params; return hash;
    });
    const pending = adapter.submit(input);
    changeContext(input); ready.resolve([ep]);
    assert.equal((await pending).userOperationHash, hash);
    assert.deepEqual(sent, [rpcOperation(operation), ep]);
  }
});
test('direct submission retains its validated destination, operation and submitter across every RPC wait', async (t) => {
  for (const pauseAt of ['chain', 'hash', 'validation']) await t.test(pauseAt, async () => {
    const entered = deferred<void>(), release = deferred<void>();
    const input = structuredClone(context); const calls: any[] = []; let sent: unknown;
    const rpc: Rpc = async (method, params) => {
      const phase = method === 'eth_chainId' ? 'chain' : (params[0] as any).from ? 'validation' : 'hash';
      calls.push({ method, params: structuredClone(params) });
      if (phase === pauseAt) { entered.resolve(); await release.promise; }
      return phase === 'chain' ? toHex(84532) : phase === 'hash' ? hash : '0x';
    };
    const options: Parameters<typeof createDirectAdapter>[0] = {
      rpc, submitter, sendTransaction: async (request) => { sent = request; return tx; },
    };
    const adapter = createDirectAdapter(options), pending = adapter.submit(input);
    await entered.promise;
    changeContext(input); options.submitter = sender;
    options.rpc = async () => { throw new Error('Replaced RPC must not be used'); };
    options.sendTransaction = async () => { throw new Error('Replaced transaction sender must not be used'); };
    release.resolve();
    assert.deepEqual(await pending, { mode: 'direct', userOperationHash: hash, transactionHash: tx });
    const hashRequest = calls[1].params[0], execution = calls[2].params[0];
    assert.equal(hashRequest.to, ep); assert.equal(execution.to, ep); assert.equal(execution.from, submitter);
    assert.deepEqual(decodeFunctionData({ abi: entryPoint07Abi, data: hashRequest.data }).args, [packOperation(operation)]);
    const decoded = decodeFunctionData({ abi: entryPoint07Abi, data: execution.data });
    assert.equal(decoded.functionName, 'handleOps'); assert.deepEqual(decoded.args, [[packOperation(operation)], submitter]);
    assert.deepEqual(sent, { to: ep, data: execution.data });
  });
});
test('receipt lookups retain their original context and submission while RPC is pending', async () => {
  for (const mode of ['public', 'private', 'direct'] as const) {
    const ready = deferred<unknown>(), input = structuredClone(context);
    const submission = { mode, userOperationHash: hash, transactionHash: tx };
    const rpc: Rpc = async (method, params) => {
      assert.equal(method, mode === 'direct' ? 'eth_getTransactionReceipt' : 'eth_getUserOperationReceipt');
      assert.deepEqual(params, [mode === 'direct' ? tx : hash]); return ready.promise;
    };
    const adapter = mode === 'direct' ? createDirectAdapter({ rpc, submitter, sendTransaction: async () => tx }) : mode === 'public' ? createPublicBundlerAdapter(rpc) : createPrivateBundlerAdapter(rpc);
    const pending = adapter.status(input, submission);
    changeContext(input); submission.userOperationHash = tx; submission.transactionHash = hash;
    ready.resolve(mode === 'direct' ? receipt() : { userOpHash: hash, success: true, receipt: receipt() });
    const inclusion = await pending;
    assert.equal(inclusion.status, 'included'); assert.equal(inclusion.userOperationHash, hash); assert.equal(inclusion.transactionHash, tx);
  }
});
test('queued HTTP requests capture params and transport options before caller mutations', async () => {
  const options = { headers: { authorization: 'original-test-token' }, timeoutMs: 30000, minimumIntervalMs: 0, fetch: (async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(init.body as string);
    assert.deepEqual(request.params, [{ to: ep, data: '0xabcd' }]);
    assert.equal((init.headers as Record<string, string>).authorization, 'original-test-token');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x' }));
  }) as typeof fetch };
  const rpc = httpRpc('https://example.test', options), params = [{ to: ep, data: '0xabcd' }];
  const pending = rpc('eth_call', params);
  params[0]!.to = sender; params[0]!.data = '0x'; options.headers.authorization = 'replaced-test-token'; options.timeoutMs = -1;
  assert.equal(await pending, '0x');
});
test('RPC transport redacts endpoint and configured credentials in errors', async () => {
  const secret = 'mock-test-credential-not-real';
  const fakeFetch = (async (_url: unknown, init: RequestInit) => { const request = JSON.parse(init.body as string); return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32500, message: `Rejected ${secret} https://example.test/v2/${secret}` } }), { status: 200 }); }) as typeof fetch;
  const rpc = httpRpc(`https://example.test/v2/${secret}`, { headers: { authorization: secret }, fetch: fakeFetch });
  await assert.rejects(rpc('eth_supportedEntryPoints', []), (error: unknown) => error instanceof RpcError && error.code === -32500 && !error.message.includes(secret) && !error.message.includes('https://'));
});
