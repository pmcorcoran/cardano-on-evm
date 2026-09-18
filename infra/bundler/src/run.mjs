import { parseArgs, parseEnv } from 'node:util';
import { readFile } from 'node:fs/promises';
import { startService } from './service.mjs';

const { values } = parseArgs({ options: { config: { type: 'string' }, 'secrets-file': { type: 'string' }, state: { type: 'string' } } });
try {
  if (!values.config) throw new Error('Supply --config with a non-secret service configuration');
  const env = values['secrets-file'] ? { ...process.env, ...parseEnv(await readFile(values['secrets-file'], 'utf8')) } : process.env;
  const service = await startService({ configPath: values.config, env, statePath: values.state });
  void service.closed.then(({ unexpected }) => { if (unexpected) process.exitCode = 1; });
  let closing = false;
  const close = async () => { if (!closing) { closing = true; await service.stop(); process.exit(0); } };
  process.on('SIGTERM', close); process.on('SIGINT', close);
  process.on('SIGHUP', () => { void service.reload().catch(() => process.stderr.write('{"kind":"reload-rejected","message":"Invalid policy/configuration; previous configuration retained"}\n')); });
} catch (error) {
  // Do not serialize an upstream exception: it can include authenticated URLs.
  process.stderr.write(JSON.stringify({ kind: 'service-failed', message: error instanceof Error && !/https?:|0x[0-9a-fA-F]{64}/.test(error.message) ? error.message.slice(0, 400) : 'Startup failed; inspect sanitized lifecycle/log evidence' }) + '\n');
  process.exitCode = 1;
}
