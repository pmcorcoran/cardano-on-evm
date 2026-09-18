import { createPublicClient, http, keccak256, parseAbi, type Address } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { releaseEvidenceOutput } from './lib/release-evidence.js';

const { values } = parseArgs({ options: { network: { type: 'string', default: 'base-sepolia' }, out: { type: 'string' } } });
assert.ok(['base-sepolia', 'base-mainnet'].includes(values.network!));
const output = releaseEvidenceOutput(values.out ?? `.local/network/${values.network}.json`, ['versions.json']);
const mainnet = values.network === 'base-mainnet', chain = mainnet ? base : baseSepolia;
const client = createPublicClient({ chain, transport: http(mainnet ? process.env.BASE_MAINNET_RPC_URL ?? 'https://mainnet.base.org' : process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org') });
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
const pinned = (mainnet ? versions.baseMainnet : versions.baseSepolia).upstreamAddresses;
const addresses = {
  entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  kernelImplementation: '0xd6CEDDe84be40893d153Be9d467CD6aD37875b28',
  kernelFactory: '0x2577507b78c2008Ff367261CB6285d44ba5eF2E9',
} as const;
assert.equal(await client.getChainId(), chain.id, 'RPC does not match the selected network');
const block = await client.getBlock();
const codes = await Promise.all(Object.entries(addresses).map(async ([name, address]) => {
  const code = await client.getCode({ address, blockNumber: block.number });
  assert.ok(code && code !== '0x', `${name} is missing on the target chain`);
  assert.equal(address.toLowerCase(), pinned[name].address.toLowerCase());
  assert.equal(keccak256(code), pinned[name].runtimeCodeHash, `${name} differs from the pinned release runtime`);
  return [name, { address, codeBytes: (code.length - 2) / 2, runtimeCodeHash: keccak256(code) }];
}));
const [kernelEntryPoint, factoryImplementation] = await Promise.all([
  client.readContract({ address: addresses.kernelImplementation, abi: parseAbi(['function entrypoint() view returns (address)']), functionName: 'entrypoint', blockNumber: block.number }),
  client.readContract({ address: addresses.kernelFactory, abi: parseAbi(['function implementation() view returns (address)']), functionName: 'implementation', blockNumber: block.number }),
]);
assert.equal(kernelEntryPoint.toLowerCase(), addresses.entryPoint.toLowerCase());
assert.equal(factoryImplementation.toLowerCase(), addresses.kernelImplementation.toLowerCase());
const publicEndpoint = `https://public.pimlico.io/v2/${chain.id}/rpc`;
const response = await fetch(publicEndpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_supportedEntryPoints', params: [] }) });
assert.ok(response.ok, `Provider HTTP ${response.status}`);
const provider = await response.json() as { result?: Address[]; error?: unknown };
assert.ok(provider.result?.some((p) => p.toLowerCase() === addresses.entryPoint.toLowerCase()), 'Provider does not advertise EntryPoint v0.7');
const evidence = {
  kind: 'live-read-only-network-check', timestamp: new Date().toISOString(), chainId: chain.id,
  blockNumber: block.number.toString(), blockHash: block.hash,
  source: 'Kernel addresses from @zerodev/sdk 5.5.10 constants.ts, Kernel version 0.3.3',
  addresses: Object.fromEntries(codes), bindings: { kernelEntryPoint, factoryImplementation },
  bytecodeReproductionVerified: false,
  publicBundler: { name: 'Pimlico', endpoint: publicEndpoint, supportedEntryPoints: provider.result, accountAdmissionTested: false },
  transactionsSubmitted: [],
};
writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
