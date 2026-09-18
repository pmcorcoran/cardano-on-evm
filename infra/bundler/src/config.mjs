import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAddress } from 'viem';
import { validatePolicy } from './admission.mjs';

export function validateConfig(input) {
  const c = structuredClone(input);
  c.workerBuild ??= 'package';
  if (!['package', 'source'].includes(c.workerBuild)) throw new Error('Select the pinned package or locally rebuilt source worker');
  if (c.version !== 1 || !Number.isSafeInteger(c.chainId) || c.chainId <= 0 || !isAddress(c.entryPoint)) throw new Error('Invalid network/EntryPoint configuration');
  if (!/^0x[0-9a-f]{64}$/.test(c.entryPointCodeHash)) throw new Error('Pin the EntryPoint runtime hash');
  for (const key of ['rpcUrlEnv', 'executorKeyEnv', 'authTokenEnv']) if (!/^[A-Z][A-Z0-9_]{1,80}$/.test(c[key])) throw new Error('Invalid secret environment reference');
  if (!['127.0.0.1', '::1'].includes(c.gateway?.host)) throw new Error('Bind behind a TLS reverse proxy on loopback');
  for (const [field, min, max] of [['port', 1024, 65535], ['maxBodyBytes', 1024, 262144], ['requestsPerMinute', 1, 10000], ['maxConcurrent', 1, 100], ['upstreamTimeoutMs', 1000, 60000]]) {
    if (!Number.isInteger(c.gateway[field]) || c.gateway[field] < min || c.gateway[field] > max) throw new Error(`Invalid gateway ${field}`);
  }
  if (!c.worker || !Number.isInteger(c.worker.port) || c.worker.port < 1024 || c.worker.port > 65535 || c.worker.port === c.gateway.port) throw new Error('Invalid worker port');
  for (const field of ['verificationGas', 'callGas', 'totalGas', 'maxFeePerGas', 'maxOperationCostWei']) if (typeof c.limits?.[field] !== 'string' || !/^[1-9][0-9]{0,29}$/.test(c.limits[field])) throw new Error(`Invalid limit ${field}`);
  if (typeof c.worker['safe-mode'] !== 'boolean') throw new Error('Select safe-mode explicitly');
  if (c.logging && !['info', 'warn', 'error', 'fatal'].includes(c.logging.level)) throw new Error('Unsupported log level');
  if (!c.worker['safe-mode'] && (typeof c.admissionDeviationReason !== 'string' || c.admissionDeviationReason.length < 20)) throw new Error('Document the validation-rule deviation');
  for (const field of ['executor-private-keys', 'utility-private-key', 'rpc-url', 'send-transaction-rpc-url', 'entrypoints', 'rpc-methods', 'log-level', 'json']) if (field in c.worker) throw new Error(`Use the supported reference for ${field}`);
  for (const field of ['dangerous-skip-user-operation-validation', 'enable-debug-endpoints', 'enable-instant-bundling-endpoint', 'enable-cors', 'deploy-simulations-contract', 'refilling-wallets']) if (c.worker[field] !== false) throw new Error(`${field} must be false in the supplied service`);
  c.policy = validatePolicy(c.policy);
  return c;
}
export const loadConfig = async (path) => validateConfig(JSON.parse(await readFile(path, 'utf8')));
export const configHash = (config) => createHash('sha256').update(JSON.stringify(config)).digest('hex');
export function credentials(config, env) {
  const rpcUrl = env[config.rpcUrlEnv], key = env[config.executorKeyEnv], token = env[config.authTokenEnv];
  const url = new URL(rpcUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('RPC must use HTTP(S)');
  if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) throw new Error('Executor key is missing or invalid');
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('Use a random 32+ character gateway token');
  return { rpcUrl, key, token };
}
