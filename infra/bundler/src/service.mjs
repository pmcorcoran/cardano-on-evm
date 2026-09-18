import { fork } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { credentials, loadConfig, configHash } from './config.mjs';
import { methods, startGateway } from './gateway.mjs';
import { patchedText } from './patches.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function rpcPost(url, request, timeout = 15000) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`);
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2 * 1024 * 1024) throw new Error('Upstream response too large'); chunks.push(value); }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function startService({ configPath, env = process.env, statePath = resolve(root, '.local/service-state.json'), log = (record) => process.stdout.write(`${JSON.stringify(record)}\n`) }) {
  let config = await loadConfig(configPath);
  const secret = credentials(config, env);
  const pin = JSON.parse(await readFile(resolve(root, 'upstream.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(resolve(root, 'node_modules/@pimlico/alto/package.json'), 'utf8'));
  if (pkg.version !== pin.version) throw new Error('Worker version differs from its pin');
  for (const patch of pin.patches) {
    const text = await readFile(resolve(root, 'node_modules/@pimlico/alto', patch.installedPath), 'utf8');
    if (text !== patchedText(text, patch).changed) throw new Error('Run npm run prepare:worker for all pinned worker patches');
  }
  let workerEntry = resolve(root, 'node_modules/@pimlico/alto/esm/cli/alto.js');
  if (config.workerBuild === 'source') {
    const manifest = JSON.parse(await readFile(resolve(root, '.local/source-build-manifest.json'), 'utf8'));
    const sha = (data) => createHash('sha256').update(data).digest('hex');
    if (!manifest.sourceBuildPassed || manifest.commit !== pin.commit || manifest.runtimeLockSha256 !== sha(await readFile(resolve(root, 'package-lock.json'))) || !manifest.compiledFiles?.length) throw new Error('Rebuild the pinned source worker for this dependency lock');
    const esm = resolve(root, '.local', `alto-${pin.commit}`, 'src/esm');
    for (const file of manifest.compiledFiles) {
      const path = resolve(esm, file.path);
      if (!path.startsWith(esm + '/') || sha(await readFile(path)) !== file.sha256) throw new Error('Rebuilt worker artifact differs from its source-build record');
    }
    workerEntry = resolve(esm, 'cli/alto.js');
  }
  const request = (method, params = []) => ({ jsonrpc: '2.0', id: 1, method, params });
  const chain = await rpcPost(secret.rpcUrl, request('eth_chainId'));
  if (Number(BigInt(chain.result)) !== config.chainId) throw new Error('RPC chain differs from configuration');
  const code = await rpcPost(secret.rpcUrl, request('eth_getCode', [config.entryPoint, 'latest']));
  if (!code.result || keccak256(code.result) !== config.entryPointCodeHash) throw new Error('EntryPoint runtime differs from its pinned hash');
  const redact = (value) => String(value).replaceAll(secret.key, '[executor key]').replaceAll(secret.token, '[token]').replaceAll(secret.rpcUrl, '[RPC]').replace(/https?:\/\/[^\s"'<>]+/g, '[URL]');
  let stopped = false, gateway, stopPromise, unexpected = false, resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const state = { kind: 'private-bundler-service-lifecycle', version: pin.version, commit: pin.commit, workerBuild: config.workerBuild, chainId: config.chainId, entryPoint: config.entryPoint, executor: privateKeyToAccount(secret.key).address, configHash: configHash(config), safeMode: config.worker['safe-mode'], validationSkipped: false, admissionDeviationReason: config.admissionDeviationReason ?? null, events: [] };
  const save = async (event) => { state.events.push({ at: new Date().toISOString(), ...event }); await mkdir(dirname(statePath), { recursive: true }); await writeFile(statePath, JSON.stringify(state, null, 2) + '\n'); };
  // A minimal environment prevents accidental telemetry or inherited ALTO options.
  const child = fork(resolve(root, 'src/worker.mjs'), [], { execArgv: [], env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  state.workerPid = child.pid;
  for (const [stream, level] of [[child.stdout, 'info'], [child.stderr, 'error']]) {
    let pending = '';
    stream.setEncoding('utf8'); stream.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split('\n'); pending = lines.pop().slice(-10000);
      for (const line of lines) {
        if (!line) continue;
        try { const item = JSON.parse(line); log({ kind: 'worker-log', level: item.level, message: redact(item.msg ?? 'Worker event').slice(0, 600), ...(item.err ? { error: redact(item.err.shortMessage ?? item.err.message ?? item.err).slice(0, 900), errorType: item.err.type } : {}) }); }
        catch { log({ kind: 'worker-log', level, message: redact(line).slice(0, 600) }); }
      }
    });
  }
  let workerError;
  child.on('message', (message) => { workerError = redact(message.reason ?? 'Worker startup failed'); log({ kind: message.kind, message: workerError }); });
  child.on('error', () => { workerError = 'Worker process failed'; });
  const workerUrl = `http://127.0.0.1:${config.worker.port}`;
  const stop = () => stopPromise ??= (async () => {
    stopped = true;
    await gateway?.stop();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000); timer.unref();
      await exited; clearTimeout(timer);
    }
    await save({ status: 'stopped', workerExited: child.exitCode !== null || child.signalCode !== null, gatewayClosed: true });
    log({ kind: 'service-stopped', chainId: config.chainId });
    resolveClosed({ unexpected });
  })();
  const args = { ...config.worker, entrypoints: config.entryPoint, 'rpc-url': secret.rpcUrl, 'executor-private-keys': secret.key, 'rpc-methods': methods.join(','), 'log-level': config.logging?.level ?? 'warn', json: true };
  child.send({ args, entryModule: pathToFileURL(workerEntry).href });
  try {
    await save({ status: 'starting' });
    let ready = false;
    for (let attempt = 0; attempt < 45; attempt++) {
      if (workerError || child.exitCode !== null || child.signalCode !== null) throw new Error(workerError ?? 'Worker exited before readiness');
      try {
        const result = await rpcPost(workerUrl, request('eth_supportedEntryPoints'), 2000);
        if (!Array.isArray(result.result) || !result.result.some((ep) => ep.toLowerCase() === config.entryPoint.toLowerCase())) throw new Error('Worker EntryPoint mismatch');
        ready = true; break;
      } catch { await new Promise((resolve) => setTimeout(resolve, 1000)); }
    }
    if (!ready) throw new Error('Worker did not become ready');
    gateway = await startGateway({ config, token: secret.token, log, forward: (request, timeout) => rpcPost(workerUrl, request, timeout) });
    await save({ status: 'ready', gatewayPort: config.gateway.port, workerPort: config.worker.port });
    log({ kind: 'service-ready', chainId: config.chainId, gatewayPort: config.gateway.port, workerPort: config.worker.port, configHash: configHash(config), safeMode: config.worker['safe-mode'] });
    child.on('exit', () => { if (!stopped) { unexpected = true; log({ kind: 'worker-unexpected-exit' }); void stop(); } });
    return {
      config, state, stop, closed,
      async reload() {
        const next = await loadConfig(configPath); gateway.reload(next); config = next;
        state.configHash = configHash(next); await save({ status: 'reloaded', policyRevision: next.policy.revision, configHash: state.configHash });
      },
    };
  } catch (error) { await stop(); throw error; }
}
