/** Preload for local acceptance processes. Dependency downloads run separately.
 * Deny non-loopback TCP connections before DNS/connect, including Node fetch.
 */
import net from 'node:net';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function loopbackTarget(args) {
  let options = args[0];
  if (Array.isArray(options)) return loopbackTarget(options);
  if (typeof options === 'object' && options !== null) {
    if (options.path !== undefined) return; // local IPC used by tsx/esbuild
  } else if (typeof options === 'string' && !/^\d+$/.test(options)) return; // local IPC
  else options = { port: options, host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  const host = options.host ?? options.hostname ?? 'localhost';
  if (!['127.0.0.1', '::1', '[::1]', 'localhost'].includes(host)) {
    const error = new Error('LOCAL_NETWORK_DENIED: external TCP unavailable during local acceptance');
    error.code = 'LOCAL_NETWORK_DENIED';
    if (process.env.LOCAL_NETWORK_LOG) appendFileSync(process.env.LOCAL_NETWORK_LOG, JSON.stringify({ kind: 'external-connect-denied', host: String(host).slice(0, 255) }) + '\n');
    throw error;
  }
  // Avoid DNS for localhost, making this guard independent of resolver setup.
  if (host === 'localhost' && typeof args[0] === 'object') args[0].host = '127.0.0.1';
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) { loopbackTarget(args); return connect.apply(this, args); };
// The private service intentionally supplies a minimal worker environment and
// empty execArgv. Enforce this test-only preload across that fork too, without
// changing the production service's environment or credential boundaries.
const fork = childProcess.fork;
childProcess.fork = function (modulePath, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  options = { ...options };
  options.execArgv = [...(options.execArgv ?? process.execArgv), '--import', fileURLToPath(import.meta.url)];
  options.env = { ...(options.env ?? process.env), ...(process.env.LOCAL_NETWORK_LOG ? { LOCAL_NETWORK_LOG: process.env.LOCAL_NETWORK_LOG } : {}) };
  return fork(modulePath, args, options);
};
syncBuiltinESMExports();
