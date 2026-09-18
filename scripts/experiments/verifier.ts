import { createPublicClient, createWalletClient, http, type Abi, type Hex, type Address } from 'viem';
import './errors.js';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { ed25519 } from '@noble/curves/ed25519.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { compileContracts, type Artifact } from '../build-contracts.js';
import { fixtureAddress, fixturePublicKey, signFixture } from '../../tests/fixtures.js';
import { toHex, fromHex, verifyCip8Signature } from '../../packages/wallet/src/index.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha512 } from '@noble/hashes/sha2.js';

const url = process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8545';
const client = createPublicClient({ chain: foundry, transport: http(url) });
assert.equal(await client.getChainId(), 31337, 'Experiment must run on a local chain');
// Anvil's publicly known local test account. Never used on a public network.
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const wallet = createWalletClient({ chain: foundry, transport: http(url), account });
const artifacts = compileContracts();
const deployed = new Map<string, Address>();
async function deploy(file: string, name: string): Promise<Address> {
  const id = `${file}:${name}`;
  if (deployed.has(id)) return deployed.get(id)!;
  const artifact = artifacts[file]![name]!;
  let bytecode = artifact.evm.bytecode.object;
  for (const [source, libs] of Object.entries(artifact.evm.bytecode.linkReferences)) {
    for (const [lib, locations] of Object.entries(libs)) {
      const address = (await deploy(source, lib)).slice(2);
      for (const { start, length } of locations) bytecode = bytecode.slice(0, start * 2) + address.padStart(length * 2, '0') + bytecode.slice((start + length) * 2);
    }
  }
  const hash = await wallet.deployContract({ abi: artifact.abi as Abi, bytecode: `0x${bytecode}` });
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success'); assert.ok(receipt.contractAddress);
  deployed.set(id, receipt.contractAddress); return receipt.contractAddress;
}

const verifier = await deploy('contracts/experiments/VerifierHarness.sol', 'VerifierHarness');
const abi = artifacts['contracts/experiments/VerifierHarness.sol']!.VerifierHarness!.abi as Abi;
const shaTests = [];
for (const length of [0, 1, 31, 32, 63, 64, 91, 111, 112, 113, 119, 127, 128, 129, 239, 240, 255, 256, 257, 1024, 4096]) {
  const message = Uint8Array.from({ length }, (_, i) => (i * 127 + length) % 256);
  const expected = createHash('sha512').update(message).digest('hex');
  assert.equal(toHex(sha512(message)), expected);
  const result = await client.readContract({ address: verifier, abi, functionName: 'sha512', args: [`0x${toHex(message)}`] }) as [Hex, Hex];
  assert.equal(result[0].slice(2) + result[1].slice(2), expected, `SHA512 length ${length}`);
  shaTests.push({ length, matchedOpenSSLAndNoble: true });
}
// Public-coordinate conversion only, using the constants in the pinned SCL source.
const field = (1n << 255n) - 19n;
const mod = (v: bigint) => ((v % field) + field) % field;
function power(a: bigint, n: bigint): bigint { let r = 1n; for (; n; n >>= 1n, a = mod(a * a)) if (n & 1n) r = mod(r * a); return r; }
const inv = (v: bigint) => power(mod(v), field - 2n);
const constants = readFileSync('vendor/scl/src/fields/SCL_wei25519.sol', 'utf8');
const constant = (key: string) => BigInt(constants.match(new RegExp(`constant ${key}\\s*=\\s*(0x[0-9a-fA-F]+|[0-9]+)\\s*;`))![1]!);
function extendedKey(key: Uint8Array) {
  const point = ed25519.Point.fromBytes(key).toAffine();
  const wx = mod(constant('delta') + mod(1n + point.y) * inv(1n - point.y));
  const wy = mod(constant('c') * mod(1n + point.y) * inv(mod((1n - point.y) * point.x)));
  const high = ed25519.Point.fromBytes(key).multiply(1n << 128n).toAffine();
  const wx128 = mod(constant('delta') + mod(1n + high.y) * inv(1n - high.y));
  const wy128 = mod(constant('c') * mod(1n + high.y) * inv(mod((1n - high.y) * high.x)));
  return [wx, wy, wx128, wy128, BigInt(`0x${toHex(key)}`)];
}
const results = [];
const cases: { source: string; addressType: number; verified: ReturnType<typeof verifyCip8Signature> }[] = [];
for (const type of [6, 0, 14] as const) {
  const address = fixtureAddress(type);
  const payload = new Uint8Array(32).fill(0x42);
  const verified = verifyCip8Signature(signFixture(payload, address), { address: toHex(address), network: 0, payload });
  cases.push({ source: 'generated fixture', addressType: type, verified });
}
for (const vector of JSON.parse(readFileSync('fixtures/wallet-signatures.json', 'utf8')).records.filter((item: any) => item.accepted)) {
  const verified = verifyCip8Signature(vector.signed, { address: vector.address, network: vector.network, payload: fromHex(vector.payload) });
  cases.push({ source: `generated-wallet:${vector.id}`, addressType: vector.type, verified });
}
for (const { source, addressType, verified } of cases) {
  const extended = extendedKey(verified.publicKey);
  const args = [`0x${toHex(verified.signStructure)}`, `0x${toHex(verified.signature.slice(0, 32))}`, `0x${toHex(verified.signature.slice(32))}`, extended] as const;
  assert.equal(await client.readContract({ address: verifier, abi, functionName: 'verify', args }), true);
  const gas = await client.estimateContractGas({ address: verifier, abi, functionName: 'verify', args, account });
  const mutated = [...args]; mutated[0] = `${args[0].slice(0, -2)}${(parseInt(args[0].slice(-2), 16) ^ 1).toString(16).padStart(2, '0')}` as Hex;
  assert.equal(await client.readContract({ address: verifier, abi, functionName: 'verify', args: mutated }), false);
  assert.equal(await client.readContract({ address: verifier, abi, functionName: 'verifyOptimized', args }), true);
  const optimizedGas = await client.estimateContractGas({ address: verifier, abi, functionName: 'verifyOptimized', args, account });
  assert.equal(await client.readContract({ address: verifier, abi, functionName: 'verifyOptimized', args: mutated }), false);
  assert.equal(await client.readContract({ address: verifier, abi, functionName: 'verifyPrecomputed', args }), true);
  assert.equal(await client.readContract({ address: verifier, abi, functionName: 'verifyPrecomputed', args: mutated }), false);
  const precomputedGas = await client.estimateContractGas({ address: verifier, abi, functionName: 'verifyPrecomputed', args, account });
  const shaInput = new Uint8Array(64 + verified.signStructure.length);
  shaInput.set(verified.signature.slice(0, 32)); shaInput.set(verified.publicKey, 32); shaInput.set(verified.signStructure, 64);
  const shaGas = await client.estimateContractGas({ address: verifier, abi, functionName: 'sha512', args: [`0x${toHex(shaInput)}`], account });
  results.push({ source, addressType, signStructureBytes: verified.signStructure.length, isolatedEstimateGas: gas.toString(), optimizedIsolatedEstimateGas: optimizedGas.toString(), precomputedIsolatedEstimateGas: precomputedGas.toString(), shaOnlyIsolatedEstimateGas: shaGas.toString(), validAccepted: true, mutationRejected: true });
}
const evidence = { timestamp: new Date().toISOString(), kind: 'local-isolated-verifier-with-generated-signatures', chainId: 31337, fullKernelPath: false, realWalletIncluded: false, publicProviderAccepted: false, keyValidationIncluded: false, sclCommit: 'd714e9824e2e2e44be3c8fd498e0de651ddc9425', compiler: JSON.parse(readFileSync('artifacts/build.json', 'utf8')), results, shaTests };
mkdirSync('evidence/local', { recursive: true });
writeFileSync('evidence/local/verifier.json', JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
