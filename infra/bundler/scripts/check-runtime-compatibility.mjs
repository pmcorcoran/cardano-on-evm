// Exercise the migrated dependencies through the selected real Alto RPC server.
// All network traffic is local; telemetry uses a disposable local collector.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Writable } from 'node:stream';

const pin = JSON.parse(await readFile(new URL('../upstream.json', import.meta.url)));
const source = process.env.ALTO_TEST_WORKER === 'source';
const worker = new URL(source ? `../.local/alto-${pin.commit}/src/esm/` : '../node_modules/@pimlico/alto/esm/', import.meta.url);
const require = createRequire(new URL('../package.json', worker));
let telemetryRequests = 0;
const collector = createServer((request, response) => {
  assert.equal(request.url, '/v1/traces');
  let bytes = 0;
  request.on('data', (chunk) => { bytes += chunk.length; });
  request.on('end', () => { if (bytes) telemetryRequests++; response.end(); });
});
await new Promise((resolve, reject) => { collector.once('error', reject); collector.listen(0, '127.0.0.1', resolve); });
process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `http://127.0.0.1:${collector.address().port}/v1/traces`;
process.env.OTEL_BSP_SCHEDULE_DELAY = '100';
process.env.OTEL_LOGS_EXPORTER = 'none';
process.env.OTEL_METRICS_EXPORTER = 'none';
await import(new URL('cli/instrumentation.js', worker));
const { Server } = await import(new URL('rpc/server.js', worker));
const { createMetrics } = await import(new URL('utils/metrics.js', worker));
const { Registry } = require('prom-client');
const loggerLines = [];
const logger = require('pino')({ level: 'info' }, new Writable({ write(chunk, _encoding, done) { loggerLines.push(chunk.toString()); done(); } }));
const registry = new Registry();
const methods = [];
const server = new Server({
  config: { getLogger: () => logger, logLevel: 'info', timeout: 5000, port: 0, enableCors: true,
    websocket: true, websocketMaxPayloadSize: 65536, defaultApiVersion: 'v2', apiVersion: ['v1', 'v2'], rpcMethods: ['eth_chainId'] },
  rpcEndpoint: { async handleMethod(request, version) { methods.push({ request, version }); return '0x7a69'; } },
  registry, metrics: createMetrics(registry),
});
try {
  await server.fastify.ready();
  assert.equal(server.fastify.hasRequestDecorator('opentelemetry'), true, 'Fastify 5 route instrumentation must register');
  const listening = once(server.fastify.server, 'listening');
  server.start();
  await listening;
  const address = server.fastify.server.address();
  assert.equal(address.address, '127.0.0.1');
  const origin = `http://127.0.0.1:${address.port}`;
  const body = { jsonrpc: '2.0', id: 7, method: 'eth_chainId', params: [] };
  for (const path of ['/', '/rpc', '/v1/rpc', '/v2/rpc']) {
    const response = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: 7, result: '0x7a69' });
  }
  assert.deepEqual(methods.map((item) => item.version), ['v2', 'v2', 'v1', 'v2']);
  assert.equal((await fetch(origin + '/health')).status, 200);
  assert.equal((await fetch(origin + '/unknown-private-path')).status, 404);
  const beforeInvalid = methods.length;
  for (const invalid of ['null', '10', '"10"', '[]', '{']) {
    const response = await fetch(origin + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: invalid });
    assert.ok((await response.json()).error);
  }
  const ambiguous = await fetch(origin + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json\ta' }, body: JSON.stringify(body) });
  assert.equal(ambiguous.status, 415);
  assert.equal(methods.length, beforeInvalid);
  const cors = await fetch(origin + '/rpc', { method: 'OPTIONS', headers: { origin: 'https://example.invalid', 'access-control-request-method': 'POST' } });
  assert.equal(cors.headers.get('access-control-allow-origin'), 'https://example.invalid');
  const WebSocket = require('ws');
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/v2/rpc');
  try {
    await once(socket, 'open');
    const response = once(socket, 'message');
    socket.send(JSON.stringify(body));
    assert.equal(JSON.parse((await response)[0]).result, '0x7a69');
  } finally { socket.close(); await once(socket, 'close'); }
  const metrics = await (await fetch(origin + '/metrics')).text();
  assert.match(metrics, /route="unmatched"/);
  assert.ok(!metrics.includes('unknown-private-path'));
  assert.ok(loggerLines.some((line) => line.includes('incoming request')));

  // Native fetch, viem and Fastify instrumentation share the upgraded SDK.
  const { trace } = require('@opentelemetry/api');
  const viem = require('viem');
  await trace.getTracer('compatibility').startActiveSpan('local-rpc', async (span) => {
    try {
      const client = viem.createPublicClient({ transport: viem.http(origin + '/rpc') });
      assert.equal(await client.getChainId(), 31337);
    } finally { span.end(); }
  });
  for (let attempt = 0; telemetryRequests === 0 && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(telemetryRequests > 0, 'The patched instrumentation must export actual local traces');

  const sentry = require('@sentry/node');
  const envelopes = [];
  sentry.init({ dsn: 'http://public@127.0.0.1/1', defaultIntegrations: false, skipOpenTelemetrySetup: true,
    tracesSampleRate: 0, profilesSampleRate: 0, integrations: [sentry.httpIntegration({ spans: false })],
    transport: () => ({ send(envelope) { envelopes.push(envelope); return Promise.resolve({ statusCode: 200 }); }, flush() { return Promise.resolve(true); } }),
  });
  sentry.captureException(new Error('local compatibility fixture'));
  assert.equal(await sentry.flush(5000), true);
  assert.ok(envelopes.length > 0);
  await sentry.close(5000);

  const bullRequire = createRequire(require.resolve('bull'));
  const uuid = bullRequire('uuid');
  const TimerManager = bullRequire('./lib/timer-manager.js');
  const manager = new TimerManager();
  const id = manager.set('compatibility', 60000, () => assert.fail('Timer must be cleared'));
  try { assert.equal(uuid.validate(id), true); assert.equal(uuid.version(id), 4); }
  finally { manager.clear(id); }
  assert.equal(manager.idle, true);
  assert.throws(() => uuid.v3('fixture', uuid.v3.DNS, new Uint8Array(1)), RangeError);
  console.log(JSON.stringify({ runtimeCompatibilityPassed: true, worker: source ? 'source' : 'package',
    rpc: true, websocket: true, cors: true, loopback: true, logger: true, metrics: true, telemetry: true, sentry: true, bullUuid: true }));
} finally {
  await server.stop();
  collector.closeAllConnections();
  await new Promise((resolve) => collector.close(resolve));
}
