import test from 'node:test';
import assert from 'node:assert/strict';
import { toHex, type TransactionReceipt } from 'viem';
import { canonicalReceipt } from '../scripts/lib/canonical-receipt.js';

test('mined receipt observer rejects preconfirmations and mismatched blocks without rebroadcast', async () => {
  const hash = toHex(11, { size: 32 }); const blockHash = toHex(22, { size: 32 }); let reads = 0;
  const client = {
    async getTransactionReceipt() { reads++; return { transactionHash: hash, blockNumber: 7n, blockHash: reads === 1 ? toHex(0, { size: 32 }) : blockHash } as TransactionReceipt; },
    async getBlock() { return { hash: reads === 2 ? toHex(33, { size: 32 }) : blockHash }; },
  };
  const result = await canonicalReceipt(client, hash, { pollMs: 0, timeoutMs: 1000 });
  assert.equal(reads, 3); assert.equal(result.blockHash, blockHash);
});
