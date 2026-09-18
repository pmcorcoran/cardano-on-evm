import './errors.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, http, type Hex } from 'viem';
import { foundry } from 'viem/chains';
import assert from 'node:assert/strict';

const file = 'evidence/local/prepared-key-lace-headers-failure.json';
const evidence = JSON.parse(readFileSync(file, 'utf8'));
const client = createPublicClient({ chain: foundry, transport: http('http://127.0.0.1:8545') });
assert.equal(await client.getChainId(), 31337);
interface Trace { to?: string; input?: Hex; gasUsed?: Hex; calls?: Trace[] }
const trace = await (client.request as (request: unknown) => Promise<Trace>)({ method: 'debug_traceTransaction', params: [evidence.transactionHash, { tracer: 'callTracer' }] });
const frames: object[] = [];
function walk(t: Trace, depth: number) {
  const name = Object.entries(evidence.addresses).find(([, address]) => String(address).toLowerCase() === t.to?.toLowerCase())?.[0];
  if (name) frames.push({ name, selector: t.input?.slice(0, 10), gas: BigInt(t.gasUsed ?? '0x0').toString(), depth });
  for (const c of t.calls ?? []) walk(c, depth + 1);
}
walk(trace, 0);
writeFileSync(file, JSON.stringify({ ...evidence, frames }, null, 2) + '\n');
console.log(JSON.stringify(frames, null, 2));
