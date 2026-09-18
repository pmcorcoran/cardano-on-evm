import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('migrated RPC, telemetry and queue dependencies retain runtime behavior', { timeout: 60000 }, async () => {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(OTEL_|SENTRY_|ALTO_|BUNDLER_)/.test(name) || /PRIVATE_KEY|SUBMITTER/.test(name)) delete env[name];
  }
  env.ALTO_TEST_WORKER = process.env.ALTO_TEST_WORKER === 'source' ? 'source' : 'package';
  env.DOTENV_CONFIG_PATH = '/dev/null';
  const { stdout } = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('../scripts/check-runtime-compatibility.mjs', import.meta.url))], { env, timeout: 50000, maxBuffer: 1024 * 1024 });
  assert.match(stdout, /"runtimeCompatibilityPassed":true/);
});
