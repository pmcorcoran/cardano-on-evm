import type { Hex, TransactionReceipt } from 'viem';

interface ReceiptClient {
  getTransactionReceipt(input: { hash: Hex }): Promise<TransactionReceipt>;
  getBlock(input: { blockNumber: bigint }): Promise<{ hash: Hex | null }>;
}
/** Base may return a Flashblock preconfirmation with a zero block hash. Keep
 * observing the same transaction until its receipt agrees with a mined block. */
export async function canonicalReceipt(client: ReceiptClient, hash: Hex, options: { timeoutMs?: number; pollMs?: number } = {}): Promise<TransactionReceipt> {
  const deadline = Date.now() + (options.timeoutMs ?? 45000);
  do {
    try {
      const receipt = await client.getTransactionReceipt({ hash });
      if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new Error('Receipt transaction hash mismatch');
      if (receipt.blockHash && !/^0x0+$/.test(receipt.blockHash)) {
        const block = await client.getBlock({ blockNumber: receipt.blockNumber });
        if (block.hash?.toLowerCase() === receipt.blockHash.toLowerCase()) return receipt;
      }
    } catch { /* Not found yet, preconfirmation, a reorg, or transient RPC error. */ }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1500));
  } while (Date.now() < deadline);
  throw new Error('Mined receipt remains pending; observe the same transaction hash again');
}
