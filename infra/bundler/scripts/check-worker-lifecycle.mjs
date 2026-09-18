import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const root = process.cwd(), rpcUrl = process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8545';
const rpc = async (method, params = []) => {
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(5000) });
  const body = await response.json(); if (body.error) throw new Error(body.error.message); return body.result;
};
assert.equal(await rpc('eth_chainId'), '0x7a69', 'This lifecycle regression only runs on the disposable local chain');
const { values } = parseArgs({ options: { 'source-worker': { type: 'boolean', default: false }, config: { type: 'string' }, out: { type: 'string' } } });
assert.ok(values.config && values.out, 'Supply --config and --out for this local lifecycle check');
const sourceWorker = values['source-worker'];
const config = JSON.parse(await readFile(values.config, 'utf8'));
assert.equal(config.chainId, 31337);
config.gateway.port = Number(process.env.LOCAL_BUNDLER_LIFECYCLE_GATEWAY_PORT ?? '4397');
config.worker.port = Number(process.env.LOCAL_BUNDLER_LIFECYCLE_WORKER_PORT ?? '4398');
const ports = [config.gateway.port, config.worker.port];
for (const port of ports) assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Invalid lifecycle port');
assert.notEqual(...ports);
const configPath = resolve(root, '.local/private-bundler/lifecycle-check.json'), statePath = resolve(root, '.local/private-bundler/lifecycle-check-state.json');
await writeFile(configPath, JSON.stringify(config));
const connects = (port) => new Promise((resolve, reject) => {
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.setTimeout(1500, () => { socket.destroy(); reject(new Error('Unexpected connection timeout')); });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', (error) => { socket.destroy(); if (error.code === 'ECONNREFUSED') resolve(false); else reject(error); });
});
for (const port of ports) assert.equal(await connects(port), false);
const logs = [];
const runner = spawn(process.execPath, ['infra/bundler/src/run.mjs', `--config=${configPath}`, `--state=${statePath}`], {
  cwd: root, env: { PATH: process.env.PATH, ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}), ...(process.env.LOCAL_NETWORK_LOG ? { LOCAL_NETWORK_LOG: process.env.LOCAL_NETWORK_LOG } : {}), BASE_SEPOLIA_RPC_URL: rpcUrl, BUNDLER_AUTH_TOKEN: randomBytes(32).toString('base64url'), BUNDLER_EXECUTOR_PRIVATE_KEY: `0x${randomBytes(32).toString('hex')}` }, stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = new Promise((resolve, reject) => { runner.once('error', reject); runner.once('exit', (code, signal) => resolve({ code, signal })); });
let ready = false;
for (const stream of [runner.stdout, runner.stderr]) {
  let pending = '';
  stream.setEncoding('utf8'); stream.on('data', (chunk) => {
    const lines = (pending + chunk).split('\n'); pending = lines.pop();
    for (const line of lines) { if (!line) continue; const event = JSON.parse(line); logs.push(event); if (event.kind === 'service-ready') ready = true; }
  });
}
try {
  for (let attempt = 0; !ready && attempt < 100; attempt++) {
    assert.equal(runner.exitCode, null, 'Runner exited before readiness');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(ready, 'Runner did not become ready');
  for (const port of ports) assert.equal(await connects(port), true);
  const running = JSON.parse(await readFile(statePath, 'utf8'));
  assert.ok(Number.isInteger(running.workerPid) && running.workerPid > 1);
  assert.equal(running.events.at(-1).status, 'ready');
  process.kill(running.workerPid, 'SIGKILL');
  let timer;
  const outcome = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Runner did not terminate after worker failure')), 15000); })]); clearTimeout(timer);
  assert.deepEqual(outcome, { code: 1, signal: null });
  for (const port of ports) assert.equal(await connects(port), false);
  const stopped = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(stopped.events.at(-1).status, 'stopped'); assert.equal(stopped.events.at(-1).workerExited, true);
  assert.ok(logs.some((event) => event.kind === 'worker-unexpected-exit'));
  const evidence = { kind: 'actual-local-runner-worker-failure-regression', checkedAt: new Date().toISOString(), chainId: 31337, workerBuild: config.workerBuild ?? 'package', generatedDisposableExecutor: true, noOperationsSubmitted: true, runnerReadyBeforeKill: true, workerTerminatedUnexpectedly: true, runnerExit: outcome, bothPortsClosed: true, lifecycle: stopped, logs };
  await mkdir(resolve(values.out, '..'), { recursive: true }); await writeFile(values.out, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ runnerExit: outcome, bothPortsClosed: true, noOperationsSubmitted: true }));
} finally {
  if (runner.exitCode === null && runner.signalCode === null) {
    runner.kill('SIGTERM');
    const timer = setTimeout(() => runner.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  }
}
