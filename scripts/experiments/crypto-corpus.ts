import './errors.js';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ed25519, ED25519_TORSION_SUBGROUP } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { createPublicClient, createWalletClient, http, encodeDeployData, toHex, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { decodeCbor, encodeCbor, fromHex, verifyCip8Signature } from '../../packages/wallet/src/index.js';
import { fixtureAddress, signFixture } from '../../tests/fixtures.js';
import type { Artifact } from '../build-contracts.js';

// Local cryptographic differential tests. No real wallet or public chain writes.
const localRpcUrl = process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8545';
const client = createPublicClient({ chain: foundry, transport: http(localRpcUrl), pollingInterval: 50 });
assert.equal(await client.getChainId(), 31337);
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const wallet = createWalletClient({ chain: foundry, transport: http(localRpcUrl), account });
const artifacts: Record<string, Record<string, Artifact>> = JSON.parse(readFileSync('artifacts/contracts.json', 'utf8'));
const find = (name: string) => {
  const matches = Object.values(artifacts).flatMap((a) => Object.entries(a)).filter(([n]) => n === name);
  assert.equal(matches.length, 1); return matches[0]![1];
};
const libraries = new Map<string, Address>();
async function linked(name: string): Promise<Hex> {
  const artifact = find(name); let bytecode = artifact.evm.bytecode.object;
  for (const [source, refs] of Object.entries(artifact.evm.bytecode.linkReferences)) for (const [lib, positions] of Object.entries(refs)) {
    const id = `${source}:${lib}`;
    if (!libraries.has(id)) libraries.set(id, await deploy(lib));
    for (const { start, length } of positions) bytecode = bytecode.slice(0, start * 2) + libraries.get(id)!.slice(2).padStart(length * 2, '0') + bytecode.slice((start + length) * 2);
  }
  return `0x${bytecode}`;
}
async function deploy(name: string, args: readonly unknown[] = []): Promise<Address> {
  const hash = await wallet.deployContract({ abi: find(name).abi as Abi, bytecode: await linked(name), args, gas: 15_000_000n });
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', `${name} deployment`); assert.ok(receipt.contractAddress);
  return receipt.contractAddress;
}
const harness = await deploy('VerifierHarness'), abi = find('VerifierHarness').abi as Abi;
const validatorAbi = find('PreparedTableValidator').abi as Abi;
const validatorBytecode = await linked('PreparedTableValidator');
const tableCache = new Map<Hex, Address>();
async function tableFor(key: Hex): Promise<Address> {
  if (tableCache.has(key)) return tableCache.get(key)!;
  const point = ed25519.Point.fromHex(key.slice(2));
  assert.ok(!point.isSmallOrder() && point.isTorsionFree());
  const validator = await deploy('PreparedTableValidator', [account.address, key, point.toAffine().x, '0x01']);
  const table = await client.readContract({ address: validator, abi: validatorAbi, functionName: 'curveTable' }) as Address;
  tableCache.set(key, table); return table;
}
async function verify(message: Hex, signature: Hex, key: Hex, table: Address): Promise<boolean> {
  assert.equal(signature.length, 130);
  return await client.readContract({ address: harness, abi, functionName: 'verifyTable', args: [message, signature.slice(0, 66), `0x${signature.slice(66)}`, key, table] }) as boolean;
}
const provenance = JSON.parse(readFileSync('fixtures/wycheproof-provenance.json', 'utf8'));
for (const [file, expected] of Object.entries(provenance.files)) assert.equal(createHash('sha256').update(readFileSync(`fixtures/${file}`)).digest('hex'), expected);
type Vector = { tcId: number; msg: string; sig: string; result: string; flags: string[]; comment: string };
const corpus: { numberOfTests: number; testGroups: { publicKey: { pk: string }; tests: Vector[] }[] } = JSON.parse(readFileSync('fixtures/wycheproof-ed25519.json', 'utf8'));
const results = [];
const payload = new Uint8Array(32), address = fixtureAddress(0), signed = signFixture(payload, address);
for (const group of corpus.testGroups) {
  const key: Hex = `0x${group.publicKey.pk}`, table = await tableFor(key);
  for (const test of group.tests) {
    const expected = test.result === 'valid';
    assert.ok(test.result === 'valid' || test.result === 'invalid');
    let noble = false;
    try { noble = ed25519.verify(fromHex(test.sig), fromHex(test.msg), fromHex(group.publicKey.pk), { zip215: false }); } catch { /* malformed signature is invalid */ }
    assert.equal(noble, expected, `independent oracle tcId ${test.tcId}`);
    if (test.sig.length !== 128) {
      // The EVM API receives two bytes32 values; malformed lengths are rejected
      // by the real CIP-8 decoder before that representation can be constructed.
      const sign1 = decodeCbor(fromHex(signed.signature), true) as unknown[];
      sign1[3] = fromHex(test.sig);
      assert.throws(() => verifyCip8Signature({ ...signed, signature: toHex(encodeCbor(sign1 as any)).slice(2) }, { address: toHex(address).slice(2), network: 0, payload }), /signature length/);
      assert.equal(expected, false);
      results.push({ id: test.tcId, expected: test.result, result: false, path: 'CIP-8 signature length rejection', flags: test.flags });
    } else {
      const accepted = await verify(`0x${test.msg}`, `0x${test.sig}`, key, table);
      assert.equal(accepted, expected, `EVM tcId ${test.tcId}: ${test.comment}`);
      results.push({ id: test.tcId, expected: test.result, result: accepted, path: 'onchain table verifier', flags: test.flags });
    }
  }
}
assert.equal(results.length, corpus.numberOfTests);
console.log(JSON.stringify({ stage: 'Wycheproof', vectors: results.length, keys: tableCache.size }));

function seededBytes(label: string, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 32) bytes.set(createHash('sha256').update(`cardano-kernel:crypto-corpus:v1:${label}:${i}`).digest().subarray(0, Math.min(32, length - i)), i);
  return bytes;
}
const boundaries = [0, 1, 31, 32, 47, 48, 63, 64, 110, 111, 112, 113, 127, 128, 129, 239, 240, 255, 256, 257, 1023, 1024, 4032, 4095, 4096];
const lengths = [...boundaries, ...Array.from({ length: 40 }, (_, i) => Number(BigInt(toHex(seededBytes(`sha-length:${i}`, 4))) % 4097n))];
for (const [index, length] of lengths.entries()) {
  const bytes = seededBytes(`sha:${index}`, length), openssl = createHash('sha512').update(bytes).digest('hex');
  assert.equal(toHex(sha512(bytes)).slice(2), openssl);
  const output = await client.readContract({ address: harness, abi, functionName: 'sha512', args: [toHex(bytes)] }) as readonly [Hex, Hex];
  assert.equal(output[0].slice(2) + output[1].slice(2), openssl, `SHA-512 length ${length}`);
}
await assert.rejects(client.readContract({ address: harness, abi, functionName: 'sha512', args: [toHex(seededBytes('oversized', 4097))] }), /SHA512 input limit/);

const generated = [];
for (let k = 0; k < 4; k++) {
  const seed = seededBytes(`signing-key:${k}`, 32), publicKey = ed25519.getPublicKey(seed), key = toHex(publicKey), table = await tableFor(key);
  for (const length of [0, 1, 32, 47, 48, 63, 64, 111, 112, 128, 255, 1024, 4032]) {
    const message = seededBytes(`message:${k}:${length}`, length), sig = ed25519.sign(message, seed);
    assert.equal(await verify(toHex(message), toHex(sig), key, table), true);
    const changedMessage = length ? message.slice() : Uint8Array.of(1); if (length) changedMessage[0]! ^= 1;
    const changedR = sig.slice(); changedR[0]! ^= 1;
    const changedS = sig.slice(); changedS[63]! ^= 1;
    for (const [m, s] of [[changedMessage, sig], [message, changedR], [message, changedS]]) assert.equal(await verify(toHex(m!), toHex(s!), key, table), false);
    generated.push({ key, length, validAccepted: true, alteredMessageRAndSRejected: true });
  }
}
const field = (1n << 255n) - 19n;
const invalidKeys: { label: string; key: Hex; x: bigint }[] = [];
for (const [i, encoded] of ED25519_TORSION_SUBGROUP.entries()) {
  const point = ed25519.Point.fromHex(encoded);
  invalidKeys.push({ label: `torsion-${i}`, key: `0x${encoded}`, x: point.toAffine().x });
  if (!point.equals(ed25519.Point.ZERO)) {
    const mixed = point.add(ed25519.Point.BASE);
    invalidKeys.push({ label: `mixed-torsion-${i}`, key: toHex(mixed.toBytes()), x: mixed.toAffine().x });
  }
}
const good = ed25519.Point.BASE;
for (const x of [0n, field, field + 1n, good.toAffine().x + 1n, field - good.toAffine().x]) invalidKeys.push({ label: `invalid-auxiliary-x-${x}`, key: toHex(good.toBytes()), x });
for (const y of [field, field + 1n, (1n << 255n) - 1n, (1n << 255n) + 1n]) invalidKeys.push({ label: `noncanonical-y-or-identity-${y}`, key: toHex(Uint8Array.from(fromHex(toHex(y, { size: 32 }))).reverse()), x: good.toAffine().x });
for (const test of invalidKeys) {
  const data = encodeDeployData({ abi: validatorAbi, bytecode: validatorBytecode, args: [account.address, test.key, test.x, '0x01'] });
  await assert.rejects(client.call({ account, data, gas: 15_000_000n }), /Key (range|sign|curve|subgroup)/, test.label);
}
const report = {
  kind: 'local-independent-cryptographic-corpus', timestamp: new Date().toISOString(), chainId: 31337,
  baseSepolia: false, realWallet: false, fullKernelPath: false, independentSecurityAudit: false,
  provenance, wycheproof: { total: results.length, valid: results.filter((r) => r.result).length,
    onchainCases: results.filter((r) => r.path === 'onchain table verifier').length,
    malformedLengthDecoderCases: results.filter((r) => r.path !== 'onchain table verifier').length, results },
  sha512: { independentImplementations: ['Node/OpenSSL', '@noble/hashes 2.4.0'], lengths, oversized4097Rejected: true },
  generatedSignatures: generated, invalidKeysRejected: invalidKeys.map((t) => t.label), preparedKeys: tableCache.size,
  compiler: JSON.parse(readFileSync('artifacts/build.json', 'utf8')).compiler,
};
mkdirSync('evidence/local', { recursive: true }); writeFileSync('evidence/local/crypto-corpus.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ file: 'evidence/local/crypto-corpus.json', vectors: results.length, sha512Cases: lengths.length, generatedSignatures: generated.length, invalidKeys: invalidKeys.length }));
