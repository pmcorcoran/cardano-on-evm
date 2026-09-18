import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export async function assertPrivateStopped(file: string) {
  const bytes = readFileSync(file), lifecycle = JSON.parse(bytes.toString());
  const stopped = lifecycle.events.at(-1);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.workerExited, true); assert.equal(stopped.gatewayClosed, true);
  const ports = [4337, 4338];
  for (const port of ports) {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); reject(new Error(`Private service is listening on ${port}`)); });
      socket.once('error', (error: NodeJS.ErrnoException) => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
      socket.setTimeout(1500, () => { socket.destroy(); reject(new Error('Cannot establish that the private service is stopped')); });
    });
  }
  return { checkedAt: new Date().toISOString(), lifecycleFile: file,
    lifecycleSha256: createHash('sha256').update(bytes).digest('hex'), stoppedAt: stopped.at,
    loopbackPorts: ports, bothConnectionsRefused: true };
}
