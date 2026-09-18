import { decodeEventLog, encodeFunctionData, getAddress, toHex, type Address, type Hex } from 'viem';
import { entryPoint07Abi } from 'viem/account-abstraction';
import { operationFromJson, operationHash, operationToJson, packOperation, type Operation } from '@cardano-on-evm/protocol';

export type Rpc = (method: string, params: readonly unknown[]) => Promise<unknown>;
export interface OperationContext { chainId: number; entryPoint: Address; operation: Operation }
export interface Submission { mode: 'public' | 'private' | 'direct'; userOperationHash: Hex; transactionHash?: Hex }
export interface Inclusion {
  status: 'pending' | 'included' | 'execution-reverted' | 'transaction-reverted';
  userOperationHash: Hex;
  transactionHash?: Hex;
  sender?: Address;
  nonce?: bigint;
  actualGasUsed?: bigint;
  actualGasCost?: bigint;
  receipt?: unknown;
}
export interface SubmissionAdapter {
  readonly mode: Submission['mode'];
  submit(context: OperationContext): Promise<Submission>;
  status(context: OperationContext, submission: Submission): Promise<Inclusion>;
}
export class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); this.name = 'RpcError'; }
}

/** Transport configuration is independent of identity. Never include endpoint
 * URLs or credentials in error messages or operation evidence. */
export function httpRpc(url: string, options: { headers?: Record<string, string>; timeoutMs?: number; minimumIntervalMs?: number; fetch?: typeof fetch } = {}): Rpc {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname))) throw new Error('Use HTTPS or a loopback RPC');
  const perform = options.fetch ?? fetch;
  const headers = { 'content-type': 'application/json', ...options.headers };
  const timeoutMs = options.timeoutMs ?? 30_000, minimumIntervalMs = options.minimumIntervalMs ?? 0;
  const sensitive = [...Object.values(headers), ...endpoint.searchParams.values(), endpoint.username, endpoint.password, ...endpoint.pathname.split('/').filter((part) => part.length > 15)].filter((value) => value.length > 3).sort((a, b) => b.length - a.length);
  let sequence = 0; let nextRequestAt = 0; let queue = Promise.resolve();
  return async (method, params) => {
    // Capture caller-owned data before a queued request can yield control.
    const id = ++sequence, payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    // Reserve request slots serially even when callers ask concurrently.
    const reserve = queue.then(async () => {
      const wait = Math.max(0, nextRequestAt - Date.now());
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      nextRequestAt = Date.now() + minimumIntervalMs;
    }); queue = reserve.catch(() => {}); await reserve;
    let response: Response;
    try { response = await perform(url, { method: 'POST', headers: { ...headers }, body: payload, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' }); }
    catch { throw new RpcError(-32098, 'RPC transport failed or timed out'); }
    if (!response.ok) throw new RpcError(-32097, `RPC HTTP status ${response.status}`);
    let body: any; try { body = await response.json(); } catch { throw new RpcError(-32096, 'Invalid RPC JSON response'); }
    if (!body || body.jsonrpc !== '2.0' || body.id !== id) throw new RpcError(-32096, 'RPC response ID mismatch');
    if (body.error) {
      let message = String(body.error.message ?? 'RPC rejected the request').replace(/https?:\/\/\S+/gi, '[endpoint withheld]').slice(0, 2000);
      for (const value of sensitive) message = message.split(value).join('[credential withheld]');
      throw new RpcError(Number(body.error.code), message);
    }
    if (!('result' in body)) throw new RpcError(-32096, 'Missing RPC result');
    return body.result;
  };
}

export function rpcOperation(operation: Operation): Record<string, string> {
  const checked = operationFromJson(operationToJson(operation));
  return Object.fromEntries(Object.entries(checked).filter(([, value]) => value !== undefined).map(([key, value]) => [key, typeof value === 'bigint' ? toHex(value) : String(value)]));
}
const hash32 = (value: unknown): Hex => { if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('Expected transaction or operation hash'); return value as Hex; };
function snapshotContext(context: OperationContext): OperationContext {
  return { chainId: context.chainId, entryPoint: context.entryPoint, operation: operationFromJson(operationToJson(context.operation)) };
}
function expected(context: OperationContext) { return operationHash(operationFromJson(operationToJson(context.operation)), context.chainId, context.entryPoint); }

/** Inspect the actual EntryPoint event, not merely an outer transaction's status. */
export function inclusionFromReceipt(context: OperationContext, receipt: any): Inclusion {
  const userOperationHash = expected(context);
  if (!receipt) return { status: 'pending', userOperationHash };
  const transactionHash = hash32(receipt.transactionHash);
  if (receipt.status === '0x0' || receipt.status === 'reverted') return { status: 'transaction-reverted', userOperationHash, transactionHash, receipt };
  if (receipt.status !== '0x1' && receipt.status !== 'success') throw new Error('Invalid transaction receipt status');
  if (!Array.isArray(receipt.logs)) throw new Error('Missing transaction logs');
  const matching = receipt.logs.flatMap((log: any) => {
    if (typeof log.address !== 'string' || log.address.toLowerCase() !== context.entryPoint.toLowerCase()) return [];
    try {
      const decoded = decodeEventLog({ abi: entryPoint07Abi, data: log.data, topics: log.topics });
      return decoded.eventName === 'UserOperationEvent' && decoded.args.userOpHash.toLowerCase() === userOperationHash.toLowerCase() ? [decoded.args] : [];
    } catch { return []; }
  });
  if (matching.length !== 1) throw new Error('Receipt lacks exactly one matching EntryPoint UserOperationEvent');
  const event = matching[0]!;
  if (getAddress(event.sender) !== getAddress(context.operation.sender) || event.nonce !== context.operation.nonce) throw new Error('Receipt operation identity mismatch');
  return { status: event.success ? 'included' : 'execution-reverted', userOperationHash, transactionHash, sender: event.sender, nonce: event.nonce, actualGasUsed: event.actualGasUsed, actualGasCost: event.actualGasCost, receipt };
}

function bundlerAdapter(mode: 'public' | 'private', rpc: Rpc): SubmissionAdapter {
  return {
    mode,
    async submit(input) {
      const context = snapshotContext(input);
      const entries = await rpc('eth_supportedEntryPoints', []);
      if (!Array.isArray(entries) || !entries.some((ep) => typeof ep === 'string' && ep.toLowerCase() === context.entryPoint.toLowerCase())) throw new Error('Bundler does not advertise this EntryPoint');
      const wanted = expected(context);
      const result = hash32(await rpc('eth_sendUserOperation', [rpcOperation(context.operation), context.entryPoint]));
      if (result.toLowerCase() !== wanted.toLowerCase()) throw new Error('Bundler returned an unexpected operation hash');
      return { mode, userOperationHash: wanted };
    },
    async status(input, submitted) {
      const context = snapshotContext(input), submission = { ...submitted };
      if (submission.mode !== mode || submission.userOperationHash !== expected(context)) throw new Error('Submission context changed');
      const result = await rpc('eth_getUserOperationReceipt', [submission.userOperationHash]) as any;
      if (result === null) return { status: 'pending', userOperationHash: submission.userOperationHash };
      if (!result || result.userOpHash?.toLowerCase() !== submission.userOperationHash.toLowerCase()) throw new Error('Bundler receipt hash mismatch');
      const inclusion = inclusionFromReceipt(context, result.receipt);
      if (!['included', 'execution-reverted'].includes(inclusion.status) || typeof result.success !== 'boolean' || result.success !== (inclusion.status === 'included')) throw new Error('Bundler receipt/event status mismatch');
      return inclusion;
    },
  };
}
export function createPublicBundlerAdapter(rpc: Rpc): SubmissionAdapter { return bundlerAdapter('public', rpc); }
export function createPrivateBundlerAdapter(rpc: Rpc): SubmissionAdapter { return bundlerAdapter('private', rpc); }

export function createDirectAdapter(options: {
  rpc: Rpc;
  submitter: Address;
  sendTransaction: (request: { to: Address; data: Hex }) => Promise<Hex>;
}): SubmissionAdapter {
  const { rpc, submitter, sendTransaction } = options;
  return {
    mode: 'direct',
    async submit(input) {
      const context = snapshotContext(input);
      const chain = await rpc('eth_chainId', []);
      if (typeof chain !== 'string' || BigInt(chain) !== BigInt(context.chainId)) throw new Error('Direct RPC chain mismatch');
      const wanted = expected(context);
      const packed = packOperation(context.operation);
      const hashData = encodeFunctionData({ abi: entryPoint07Abi, functionName: 'getUserOpHash', args: [packed] });
      if (await rpc('eth_call', [{ to: context.entryPoint, data: hashData }, 'latest']) !== wanted) throw new Error('EntryPoint operation hash mismatch');
      const data = encodeFunctionData({ abi: entryPoint07Abi, functionName: 'handleOps', args: [[packed], submitter] });
      await rpc('eth_call', [{ from: submitter, to: context.entryPoint, data }, 'latest']);
      const transactionHash = hash32(await sendTransaction({ to: context.entryPoint, data }));
      return { mode: 'direct', userOperationHash: wanted, transactionHash };
    },
    async status(input, submitted) {
      const context = snapshotContext(input), submission = { ...submitted };
      if (submission.mode !== 'direct' || !submission.transactionHash || submission.userOperationHash !== expected(context)) throw new Error('Submission context changed');
      const receipt = await rpc('eth_getTransactionReceipt', [submission.transactionHash]) as any;
      if (receipt && receipt.transactionHash?.toLowerCase() !== submission.transactionHash.toLowerCase()) throw new Error('Direct receipt hash mismatch');
      return inclusionFromReceipt(context, receipt);
    },
  };
}
