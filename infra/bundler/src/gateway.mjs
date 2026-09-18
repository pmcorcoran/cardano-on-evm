import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { admitOperation, AdmissionError } from './admission.mjs';
import { configHash } from './config.mjs';

export const methods = ['eth_chainId', 'eth_supportedEntryPoints', 'eth_sendUserOperation', 'eth_estimateUserOperationGas', 'eth_getUserOperationReceipt', 'eth_getUserOperationByHash', 'pimlico_getUserOperationGasPrice', 'pimlico_getUserOperationStatus'];
const digest = (value) => createHash('sha256').update(value).digest();
export async function startGateway({ config, token, forward, log = (event) => process.stdout.write(`${JSON.stringify(event)}\n`) }) {
  let current = config, active = 0, available = config.gateway.requestsPerMinute, lastRefill = Date.now();
  const counters = { requests: 0, admitted: 0, rejected: 0, upstreamErrors: 0, reloads: 0 };
  const wanted = digest(`Bearer ${token}`);
  const server = createServer(async (req, res) => {
    const reply = (status, value) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); } };
    if (req.url === '/health' && req.method === 'GET') return reply(200, { status: 'up' });
    if (!timingSafeEqual(wanted, digest(req.headers.authorization ?? ''))) { req.resume(); return reply(401, { error: 'Authentication required' }); }
    if (req.url === '/metrics' && req.method === 'GET') return reply(200, { ...counters, active, policyRevision: current.policy.revision, configHash: configHash(current) });
    if (req.url !== '/rpc' || req.method !== 'POST' || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) { req.resume(); return reply(400, { error: 'POST application/json to /rpc' }); }
    const now = Date.now(); available = Math.min(current.gateway.requestsPerMinute, available + (now - lastRefill) * current.gateway.requestsPerMinute / 60000); lastRefill = now;
    if (available < 1 || active >= current.gateway.maxConcurrent) { req.resume(); return reply(429, { error: 'Rate or concurrency limit' }); }
    available--; active++; counters.requests++;
    let id = null, method = 'invalid';
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > current.gateway.maxBodyBytes) throw new AdmissionError('Request body too large', -32600); chunks.push(chunk); }
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!request || Array.isArray(request) || request.jsonrpc !== '2.0' || !(typeof request.id === 'string' && request.id.length <= 128 || Number.isSafeInteger(request.id)) || !Array.isArray(request.params) || !methods.includes(request.method)) throw new AdmissionError('Unsupported JSON-RPC request', -32600);
      id = request.id; method = request.method;
      const snapshot = current;
      if (['eth_sendUserOperation', 'eth_estimateUserOperationGas'].includes(method)) {
        if (request.params.length !== 2) throw new AdmissionError('Expected operation and EntryPoint', -32602);
        admitOperation(request.params[0], request.params[1], snapshot, method === 'eth_estimateUserOperationGas');
      } else if (['eth_getUserOperationReceipt', 'eth_getUserOperationByHash', 'pimlico_getUserOperationStatus'].includes(method)) {
        if (request.params.length !== 1 || !/^0x[0-9a-fA-F]{64}$/.test(request.params[0])) throw new AdmissionError('Expected UserOperation hash', -32602);
      } else if (request.params.length !== 0) throw new AdmissionError('Expected empty params', -32602);
      const result = await forward(request, snapshot.gateway.upstreamTimeoutMs);
      if (!result || result.jsonrpc !== '2.0' || result.id !== id || (result.result === undefined) === (result.error === undefined)) throw new Error('Invalid upstream response');
      if (result.error) counters.upstreamErrors++; else counters.admitted++;
      log({ kind: 'rpc', method, policyRevision: snapshot.policy.revision, outcome: result.error ? 'upstream-rejected' : 'forwarded', code: result.error?.code });
      reply(200, result);
    } catch (error) {
      counters.rejected++;
      const code = error instanceof AdmissionError ? error.code : error instanceof SyntaxError ? -32700 : -32603;
      const message = error instanceof AdmissionError ? error.message : error instanceof SyntaxError ? 'Parse error' : 'Request or upstream failed';
      log({ kind: 'rpc', method, outcome: 'gateway-rejected', code });
      reply(200, { jsonrpc: '2.0', id, error: { code, message } });
    } finally { active--; }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000; server.maxHeadersCount = 32;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.gateway.port, config.gateway.host, resolve); });
  return {
    address: server.address(),
    reload(next) {
      // Only admission/gas/rate settings reload. Network, process and credentials
      // require a restart so queued operations cannot move to another chain.
      const omit = ({ policy, limits, admissionDeviationReason, gateway, ...rest }) => ({ ...rest, gateway: { host: gateway.host, port: gateway.port } });
      if (JSON.stringify(omit(next)) !== JSON.stringify(omit(current))) throw new Error('This configuration change requires a restart');
      current = next; available = Math.min(available, next.gateway.requestsPerMinute); counters.reloads++;
      log({ kind: 'policy-reloaded', revision: next.policy.revision, configHash: configHash(next) });
    },
    stop: () => new Promise((resolve) => { server.close(resolve); server.closeIdleConnections(); setTimeout(() => server.closeAllConnections(), 5000).unref(); }),
  };
}
