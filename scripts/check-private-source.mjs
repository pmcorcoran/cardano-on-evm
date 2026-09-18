import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { out: { type: 'string' }, anvil: { type: 'string', default: process.env.ANVIL_BIN ?? '.local/tools/foundry/anvil' }, 'port-base': { type: 'string', default: '18700' } } });
assert.ok(values.out, '--out must identify an empty directory for this run');
const out = resolve(values.out);
const anvil = values.anvil.includes('/') ? resolve(values.anvil) : values.anvil;
await mkdir(out, { recursive: false });
const logs = resolve(out, 'logs'); await mkdir(logs);
const manifest = JSON.parse(await readFile('infra/bundler/.local/source-build-manifest.json', 'utf8'));
assert.equal(manifest.sourceBuildPassed, true, 'Build the pinned Alto source first');
const base = Number(values['port-base']); assert.ok(Number.isInteger(base) && base >= 1024 && base <= 65400);
const rpcUrl = `http://127.0.0.1:${base + 98}`;
const env = { ...process.env, LOCAL_RPC_URL: rpcUrl, LOCAL_BUNDLER_GATEWAY_PORT: String(base + 87), LOCAL_BUNDLER_WORKER_PORT: String(base + 88), LOCAL_BUNDLER_LIFECYCLE_GATEWAY_PORT: String(base + 97), LOCAL_BUNDLER_LIFECYCLE_WORKER_PORT: String(base + 96) };
for (const name of Object.keys(env)) if (name.startsWith('ALTO_') || name.startsWith('BUNDLER_') || name.includes('PRIVATE_KEY') || name.includes('SUBMITTER')) delete env[name];
const report = { kind: 'private-worker-local-acceptance', startedAt: new Date().toISOString(), chainId: 31337, realWallet: false, publicTransactionsSent: 0, sourceCommit: manifest.commit, strictValidationEvidence: 'Generated deterministic parser fixture exercised against installed and freshly rebuilt source workers.', strictExecutionPerformed: false, executionValidation: 'Basic local validation with real Anvil transactions and cryptographic authorization', steps: [], allChecksPassed: false };
const save = () => writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const children = [];
async function stop(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
  if (child.exitCode === null && child.signalCode === null) {
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000);
    await new Promise((resolve) => child.once('exit', resolve)); clearTimeout(timer);
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function run(name, args, requiredLog) {
  const file = resolve(logs, `${name}.log`), descriptor = openSync(file, 'w');
  let code;
  try {
    const child = spawn(process.execPath, args, { env, detached: true, stdio: ['ignore', descriptor, descriptor] });
    children.push(child);
    const timer = setTimeout(() => { void stop(child); }, 300000);
    try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); }
    finally { clearTimeout(timer); }
  } finally { closeSync(descriptor); }
  report.steps.push({ name, command: [process.execPath, ...args], exitCode: code, log: `logs/${name}.log` }); await save();
  if (code !== 0) { process.stderr.write((await readFile(file, 'utf8')).slice(-12000)); throw new Error(`${name} failed`); }
  if (requiredLog) assert.ok((await readFile(file, 'utf8')).includes(requiredLog), `${name} did not complete the required checks`);
  console.log(`${name} passed`);
}
let evm;
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  interrupted = true;
  void Promise.all(children.map(stop)).finally(() => { process.exitCode = 1; });
});
try {
  // Never use an already-running chain: each run owns its unforked local EVM.
  try { await fetch(rpcUrl, { signal: AbortSignal.timeout(1500) }); throw new Error('Local Anvil port is already in use'); }
  catch (error) { if (error.cause?.code !== 'ECONNREFUSED') throw error; }
  const descriptor = openSync(resolve(logs, 'anvil.log'), 'w');
  evm = spawn(anvil, ['--host', '127.0.0.1', '--port', String(base + 98), '--chain-id', '31337', '--hardfork', 'cancun'], { env, detached: true, stdio: ['ignore', descriptor, descriptor] });
  children.push(evm); closeSync(descriptor);
  let started = false, startupError;
  evm.on('error', (error) => { startupError = error; });
  for (let i = 0; i < 80 && !started; i++) {
    if (startupError) throw startupError;
    assert.equal(evm.exitCode, null, 'Anvil exited before readiness');
    try {
      const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(1000) });
      started = (await response.json()).result === '0x7a69';
    } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  assert.ok(started);
  await run('local-profile-prerequisite', ['node_modules/tsx/dist/cli.mjs', 'scripts/experiments/policies.ts']);
  for (const sourceWorker of [false, true]) {
    const name = sourceWorker ? 'source' : 'package';
    env.ALTO_TEST_WORKER = name;
    const deployment = `evidence/local/private-bundler-${name}.json`, config = `.local/private-bundler/${name}.json`;
    await run(`${name}-generated-strict-parser`, ['--test', '--test-isolation=none', 'infra/bundler/tests/strict-validation.test.mjs'], '"strictParserChecksCompleted":true');
    await run(`${name}-runtime-compatibility`, ['infra/bundler/scripts/check-runtime-compatibility.mjs'], '"runtimeCompatibilityPassed":true');
    await run(`${name}-basic-local-execution`, ['node_modules/tsx/dist/cli.mjs', 'scripts/experiments/private-bundler.ts', '--basic-validation', '--policy-fixture', 'evidence/local/policies.json', '--out', deployment, '--config-out', config, ...(sourceWorker ? ['--source-worker'] : [])]);
    await run(`${name}-simulation-bytecode`, ['node_modules/tsx/dist/cli.mjs', 'scripts/experiments/verify-private-simulations.ts', '--deployment', deployment, '--rpc-url', rpcUrl, '--out', `evidence/local/private-simulation-${name}.json`]);
    await run(`${name}-unexpected-worker-exit`, ['infra/bundler/scripts/check-worker-lifecycle.mjs', '--config', config, '--out', `evidence/local/private-worker-lifecycle-${name}.json`, ...(sourceWorker ? ['--source-worker'] : [])]);
  }
  assert.equal(interrupted, false, 'Local acceptance was interrupted');
  report.allChecksPassed = true;
} catch (error) { report.failure = error.message; throw error; }
finally {
  for (const child of children.reverse()) await stop(child);
  report.servicesStopped = true; report.completedAt = new Date().toISOString(); await save();
}
