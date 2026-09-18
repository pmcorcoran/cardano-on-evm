import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { createPublicClient, formatEther, http } from 'viem';
import { baseSepolia, sepolia } from 'viem/chains';
import { loadSubmitter } from './lib/submitter.js';
import { releaseEvidenceOutput } from './lib/release-evidence.js';

// Read-only: no wallet client, signing or transaction submission in this script.
try {
  const { values } = parseArgs({ options: { 'key-file': { type: 'string' }, 'key-variable': { type: 'string', default: 'SUBMITTER_PRIVATE_KEY' }, out: { type: 'string' } } });
  if (!values['key-file'] || !values.out) throw new Error('Supply --key-file and --out, and optionally --key-variable');
  const output = releaseEvidenceOutput(values.out, [values['key-file']]);
  const { account, config } = loadSubmitter(values['key-file'], values['key-variable']!);
  const networks = [
    { chain: baseSepolia, url: process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org' },
    { chain: sepolia, url: config.ETHEREUM_SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com' },
  ];
  const checks = await Promise.all(networks.map(async ({ chain, url }) => {
    const client = createPublicClient({ chain, transport: http(url, { retryCount: 0, timeout: 15_000 }) });
    try {
      if (await client.getChainId() !== chain.id) return { chainId: chain.id, network: chain.name, error: 'RPC chain ID mismatch' };
      const blockNumber = await client.getBlockNumber();
      const balance = await client.getBalance({ address: account.address, blockNumber });
      return { chainId: chain.id, network: chain.name, blockNumber: blockNumber.toString(), balanceWei: balance.toString(), balanceEth: formatEther(balance) };
    } catch {
      // RPC errors can contain API credentials in URLs. Do not serialize them.
      return { chainId: chain.id, network: chain.name, error: 'RPC connection or balance lookup failed' };
    }
  }));
  const evidence = { kind: 'read-only-submitter-funding-check', timestamp: new Date().toISOString(), address: account.address, transactionsSubmitted: [], checks };
  if (checks.every((c) => !('error' in c))) {
    writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
  } else process.exitCode = 1;
  console.log(JSON.stringify(evidence, null, 2));
} catch {
  console.error('Submitter configuration check failed; configuration values were withheld. Check the file path, variable name and key format.');
  process.exitCode = 1;
}
