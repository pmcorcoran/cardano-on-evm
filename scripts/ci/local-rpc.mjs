/** Read-only, loopback-only fixture for the reference UI/HTTP acceptance.
 * This is deliberately separate from Anvil: it cannot execute transactions.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const address = /^0x[0-9a-f]{40}$/i;
const word = '0x' + '0'.repeat(64);
export function createReadFixture(plan, { log } = {}) {
  assert.equal(plan.kind, 'reference-read-fixture-plan');
  assert.equal(plan.chainId, 84532);
  assert.ok(address.test(plan.entryPoint));
  assert.ok(Array.isArray(plan.accounts) && plan.accounts.length > 0);
  assert.ok(Array.isArray(plan.factories) && plan.factories.length > 0);
  assert.ok([...plan.accounts, ...plan.factories].every((value) => address.test(value)));
  const accounts = new Set(plan.accounts.map((value) => value.toLowerCase()));
  const codes = new Set([...accounts, ...plan.factories.map((value) => value.toLowerCase())]);
  const expectedCalls = new Set([...accounts].flatMap((account) => {
    const argument = account.slice(2).padStart(64, '0');
    // EntryPoint.getNonce(address,uint192), EntryPoint.balanceOf(address).
    return ['0x35567e1a' + argument + '0'.repeat(64), '0x70a08231' + argument];
  }));
  const requests = [];
  const record = (method, accepted, reason) => {
    const entry = { method, accepted, ...(reason ? { reason } : {}) };
    requests.push(entry);
    if (log) appendFileSync(log, JSON.stringify(entry) + '\n');
  };
  function respond(body) {
    const id = Number.isSafeInteger(body?.id) || typeof body?.id === 'string' ? body.id : null;
    const fail = (message, code = -32602) => {
      record(typeof body?.method === 'string' ? body.method.slice(0, 100) : null, false, message);
      return { jsonrpc: '2.0', id, error: { code, message } };
    };
    if (!body || Array.isArray(body) || typeof body !== 'object' || body.jsonrpc !== '2.0' || id === null || (body.params !== undefined && !Array.isArray(body.params)) || Object.keys(body).some((key) => !['jsonrpc', 'id', 'method', 'params'].includes(key))) return fail('Unexpected JSON-RPC request', -32600);
    // JSON-RPC permits omitted params for a zero-argument method; viem uses
    // that representation for eth_chainId during actual reference startup.
    const { method, params = [] } = body;
    let result;
    if (method === 'eth_chainId' && params.length === 0) result = '0x14a34';
    else if (method === 'eth_getCode' && params.length === 2 && params[1] === 'latest' && typeof params[0] === 'string' && codes.has(params[0].toLowerCase())) result = '0x';
    else if (method === 'eth_getBalance' && params.length === 2 && params[1] === 'latest' && typeof params[0] === 'string' && accounts.has(params[0].toLowerCase())) result = '0x0';
    else if (method === 'eth_call' && params.length === 2 && params[1] === 'latest') {
      const call = params[0];
      if (!call || Array.isArray(call) || typeof call !== 'object' || Object.keys(call).sort().join(',') !== 'data,to' || typeof call.to !== 'string' || call.to.toLowerCase() !== plan.entryPoint.toLowerCase() || typeof call.data !== 'string' || !expectedCalls.has(call.data.toLowerCase())) return fail('Unexpected eth_call target or calldata');
      result = word;
    } else return fail('Request is outside the read-only fixture allowlist', -32601);
    record(method, true);
    return { jsonrpc: '2.0', id, result };
  }
  const server = createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    const host = `127.0.0.1:${server.address().port}`;
    if (req.method !== 'POST' || req.url !== '/' || req.headers.host !== host || !req.headers['content-type']?.startsWith('application/json')) {
      record(null, false, 'Unexpected HTTP request'); req.resume(); return send(403, { error: 'Expected loopback JSON-RPC POST' });
    }
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 8192) throw new Error('Request too large'); chunks.push(chunk); }
      send(200, respond(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    } catch {
      record(null, false, 'Malformed request'); send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Malformed request' } });
    }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  return { server, respond, requests };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { plan: { type: 'string' }, port: { type: 'string' }, log: { type: 'string' } } });
  assert.ok(values.plan && values.log, '--plan and --log are required');
  const port = Number(values.port); assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
  const { server } = createReadFixture(JSON.parse(readFileSync(values.plan, 'utf8')), { log: values.log });
  server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ kind: 'read-only-reference-fixture-ready', port })));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
}
