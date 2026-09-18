// Credentials arrive over IPC, never in command-line arguments or temporary JSON.
// Use Alto's CLI entry module: importing its handler/options directly triggers
// an upstream CLI circular dependency before the option exports initialize.
import { fileURLToPath } from 'node:url';

process.once('message', async ({ args, entryModule }) => {
  try {
    for (const [key, value] of Object.entries(args)) process.env[`ALTO_${key.replaceAll('-', '_').toUpperCase()}`] = String(value);
    process.env.DOTENV_CONFIG_PATH = '/dev/null';
    const entry = new URL(entryModule);
    process.argv = [process.execPath, fileURLToPath(entry), 'run'];
    await import(entry.href);
  } catch (error) {
    process.send?.({ kind: 'worker-start-failed', reason: String(error?.shortMessage ?? error?.message ?? 'Worker startup failed').slice(0, 1200) });
    process.exit(1);
  }
});
process.on('disconnect', () => process.exit(0));
