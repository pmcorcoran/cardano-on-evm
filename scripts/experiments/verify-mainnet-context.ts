import './errors.js';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { encodeAbiParameters, keccak256, toHex, type Hex } from 'viem';
import { httpRpc } from '../../packages/submission/src/index.js';
import { json } from '../lib/live-context.js';
import { releaseEvidenceOutput } from '../lib/release-evidence.js';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
if (!values.out) throw new Error('Supply an explicit --out JSON report path');
const reportFile = releaseEvidenceOutput(values.out, ['versions.json']);
const pin = JSON.parse(readFileSync('versions.json', 'utf8')).baseSepolia.upstreamAddresses;
const sepolia = httpRpc(process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org', { minimumIntervalMs: 500 });
const mainnet = httpRpc(process.env.BASE_MAINNET_RPC_URL ?? 'https://mainnet.base.org', { minimumIntervalMs: 500 });
assert.equal(await sepolia('eth_chainId', []), '0x14a34'); assert.equal(await mainnet('eth_chainId', []), '0x2105');
const hashText = (text: string) => keccak256(new TextEncoder().encode(text));
const domain = (chain: bigint) => keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }], [hashText('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'), hashText('Kernel'), hashText('0.3.3'), chain, pin.kernelImplementation.address]));
const replacements = [
  { name: 'cached chain ID', previous: toHex(84532n, { size: 32 }), expected: toHex(8453n, { size: 32 }) },
  { name: 'cached EIP-712 domain separator', previous: domain(84532n), expected: domain(8453n) },
];
const observations = [];
for (const [name, value] of Object.entries(pin) as [string, any][]) {
  const testCode = await sepolia('eth_getCode', [value.address, 'latest']) as Hex;
  const productionCode = await mainnet('eth_getCode', [value.address, 'latest']) as Hex;
  assert.equal(keccak256(testCode), value.runtimeCodeHash);
  const observed = [];
  let expected = testCode.slice(2);
  if (name === 'kernelImplementation') {
    // Walk EVM instructions, changing only complete PUSH32 immediates. Do not
    // mask arbitrary runtime bytes merely because the network differs.
    for (let offset = 0; offset < expected.length / 2;) {
      const opcode = parseInt(expected.slice(offset * 2, offset * 2 + 2), 16);
      const length = opcode >= 0x60 && opcode <= 0x7f ? opcode - 0x5f : 0;
      if (length === 32) {
        const word = `0x${expected.slice((offset + 1) * 2, (offset + 33) * 2)}`;
        const replacement = replacements.find((entry) => entry.previous === word);
        if (replacement) {
          expected = expected.slice(0, (offset + 1) * 2) + replacement.expected.slice(2) + expected.slice((offset + 33) * 2);
          observed.push({ offset: offset + 1, ...replacement });
        }
      }
      offset += 1 + length;
    }
    for (const replacement of replacements) assert.ok(observed.some((entry) => entry.name === replacement.name));
  }
  assert.equal(`0x${expected}`, productionCode, `${name} has unexplained runtime differences`);
  observations.push({ name, address: value.address, mainnetRuntimeCodeHash: keccak256(productionCode), sepoliaRuntimeCodeHash: value.runtimeCodeHash, expectedImmutableDifferences: observed, allOtherBytesIdentical: true });
}
const output = { kind: 'read-only-mainnet-protocol-context-comparison', checkedAt: new Date().toISOString(), source: 'vendor/solady/src/utils/EIP712.sol constructor and vendor/kernel/src/Kernel.sol domain name/version', chainTransactionsSent: 0, cardanoMainnetAcceptanceTested: false, observations };
writeFileSync(reportFile, json(output)); console.log(json(output));
