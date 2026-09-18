import './errors.js';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { createPublicClient, createWalletClient, http, encodeDeployData, keccak256, toHex, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { ed25519 } from '@noble/curves/ed25519.js';
import { compileContracts } from '../build-contracts.js';
import { fixtureAddress, fixturePublicKey, signFixture } from '../../tests/fixtures.js';
import { fromHex, toHex as rawHex, verifyCip8Signature } from '../../packages/wallet/src/index.js';
import { readWalletCapture } from '../lib/wallet-capture.js';
import { releaseEvidenceOutput } from '../lib/release-evidence.js';

const { values } = parseArgs({ options: { 'reuse-build': { type: 'boolean', default: false }, case: { type: 'string' }, capture: { type: 'string' }, out: { type: 'string' } } });
const url = process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8545';
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname), 'Table verification requires a loopback test chain');
const captureInput = values.capture ? readWalletCapture(values.capture) : undefined;
const client = createPublicClient({ chain: foundry, transport: http(url), pollingInterval: 50 });
assert.equal(await client.getChainId(), 31337);
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const wallet = createWalletClient({ chain: foundry, transport: http(url), account });
const artifacts: ReturnType<typeof compileContracts> = values['reuse-build'] ? JSON.parse(readFileSync('artifacts/contracts.json', 'utf8')) : compileContracts();
const find = (name: string) => { const match = Object.entries(artifacts).flatMap(([f, a]) => Object.entries(a).map(([n, v]) => ({ f, n, v }))).filter((x) => x.n === name); assert.equal(match.length, 1); return match[0]!; };
const libraries = new Map<string, Address>();
async function deploy(name: string, args: readonly unknown[] = []) {
  const { f, v } = find(name); let bytecode = v.evm.bytecode.object;
  for (const [source, refs] of Object.entries(v.evm.bytecode.linkReferences)) for (const [lib, positions] of Object.entries(refs)) {
    const id = `${source}:${lib}`;
    if (!libraries.has(id)) libraries.set(id, (await deploy(lib)).address);
    const address = libraries.get(id)!.slice(2);
    for (const { start, length } of positions) bytecode = bytecode.slice(0, start * 2) + address.padStart(length * 2, '0') + bytecode.slice((start + length) * 2);
  }
  const tx = await wallet.deployContract({ abi: v.abi as Abi, bytecode: `0x${bytecode}`, args, gas: 15_000_000n });
  const receipt = await client.waitForTransactionReceipt({ hash: tx });
  assert.equal(receipt.status, 'success', `${f}:${name} deployment`); assert.ok(receipt.contractAddress);
  return { address: receipt.contractAddress, gas: receipt.gasUsed.toString(), tx };
}
const harness = await deploy('VerifierHarness'); const abi = find('VerifierHarness').v.abi as Abi;
const validatorArtifact = find('PreparedTableValidator').v; const validatorAbi = validatorArtifact.abi as Abi;
const field = (1n << 255n) - 19n; const order = ed25519.Point.Fn.ORDER;
const mod = (v: bigint) => (v % field + field) % field;
const inverse = (v: bigint) => { let b = mod(v), e = field - 2n, result = 1n; while (e) { if (e & 1n) result = mod(result * b); b = mod(b * b); e >>= 1n; } return result; };
const delta = 0x2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad2451n;
const c = 0x70d9120b9f5ff9442d84f723fc03b0813a5e2c2eb482e57d3391fb5500ba81e7n;
type Point = InstanceType<typeof ed25519.Point>;
function w(point: Point): readonly [bigint, bigint] {
  if (point.equals(ed25519.Point.ZERO)) return [0n, 0n];
  const { x, y } = point.toAffine();
  return [mod(delta + (1n + y) * inverse(1n - y)), mod(c * (1n + y) * inverse((1n - y) * x))];
}
const cases: { name: string; point: Point; signatures: ReturnType<typeof verifyCip8Signature>[]; sourceCaptureSha256?: string }[] = [];
const payload = new Uint8Array(32).fill(0x42);
cases.push({ name: 'generated-test-key', point: ed25519.Point.fromBytes(fixturePublicKey), signatures: [verifyCip8Signature(signFixture(payload, fixtureAddress(0), undefined, true), { address: rawHex(fixtureAddress(0)), network: 0, payload })] });
const walletCases = JSON.parse(readFileSync('fixtures/wallet-signatures.json', 'utf8')).records.filter((item: any) => item.accepted);
for (const capture of walletCases) {
  const verified = verifyCip8Signature(capture.signed, { address: capture.address, network: capture.network, payload: fromHex(capture.payload) });
  cases.push({ name: `generated-wallet:${capture.id}`, point: ed25519.Point.fromBytes(verified.publicKey), signatures: [verified] });
}
if (captureInput) cases.push({ name: values.capture!, point: ed25519.Point.fromBytes(captureInput.enrollment.publicKey), signatures: [captureInput.enrollment, ...(captureInput.operation ? [captureInput.operation] : [])], sourceCaptureSha256: captureInput.sha256 });
for (const [name, point] of [['base-point', ed25519.Point.BASE], ['negative-base-point', ed25519.Point.BASE.negate()], ['base-times-2pow64', ed25519.Point.BASE.multiply(1n << 64n)]] as const) cases.push({ name, point, signatures: [] });
const results = [];
const captureOnly = values.case;
const selected = cases.filter((item) => !captureOnly || item.name === captureOnly);
assert.ok(selected.length > 0, 'At least one verifier case must be selected');
const evidenceName = captureOnly ? `table-case-${createHash('sha256').update(captureOnly).digest('hex').slice(0, 16)}.json` : 'table-verifier.json';
const output = releaseEvidenceOutput(values.out ?? `evidence/local/${evidenceName}`, values.capture ? [values.capture] : []);
for (const { name, point, signatures, sourceCaptureSha256 } of selected) {
  const key = toHex(point.toBytes()); const headers = signatures[0]?.protectedHeaders ?? Uint8Array.of(1);
  const deployment = await deploy('PreparedTableValidator', [account.address, key, point.toAffine().x, toHex(headers)]);
  const table = await client.readContract({ address: deployment.address, abi: validatorAbi, functionName: 'curveTable' }) as Address;
  const code = await client.getCode({ address: table }); assert.ok(code); assert.equal(code.length, 2 + 2 * 16385);
  const bases = [0n, 64n, 128n, 192n].map((shift) => ed25519.Point.BASE.multiply(1n << shift)).concat([0n, 64n, 128n, 192n].map((shift) => point.multiply(1n << shift)));
  const expected = new Uint8Array(16385);
  for (let mask = 0; mask < 256; mask++) {
    let sum = ed25519.Point.ZERO;
    for (let bit = 0; bit < 8; bit++) if ((mask & (1 << bit)) !== 0) sum = sum.add(bases[bit]!);
    const [x, y] = w(sum); expected.set(fromHex(toHex(x, { size: 32 })), 1 + mask * 64); expected.set(fromHex(toHex(y, { size: 32 })), 33 + mask * 64);
  }
  assert.equal(code, toHex(expected), `${name}: all 256 onchain table entries match noble`);
  const scalarCases: [bigint, bigint][] = [[0n, 0n], [1n, 0n], [0n, 1n], [1n, order - 1n], [order, order], [(1n << 256n) - 1n, 1n << 255n]];
  for (let i = 0; i < 10; i++) scalarCases.push([BigInt(`0x${createHash('sha256').update(`${name}:u:${i}`).digest('hex')}`), BigInt(`0x${createHash('sha256').update(`${name}:v:${i}`).digest('hex')}`)]);
  for (const [u, v] of scalarCases) {
    const expectedPoint = ed25519.Point.BASE.multiplyUnsafe(u % order).add(point.multiplyUnsafe(v % order));
    const actual = await client.readContract({ address: harness.address, abi, functionName: 'multiplyTable', args: [table, u, v] }) as readonly [bigint, bigint];
    assert.deepEqual(actual, w(expectedPoint), `${name}: scalar equation`);
  }
  const signatureResults = [];
  for (const signed of signatures) {
    const args = [toHex(signed.signStructure), toHex(signed.signature.slice(0, 32)), toHex(signed.signature.slice(32)), key, table] as const;
    assert.equal(await client.readContract({ address: harness.address, abi, functionName: 'verifyTable', args }), true);
    const gas = await client.estimateContractGas({ address: harness.address, abi, functionName: 'verifyTable', args, account });
    const altered = [...args]; altered[0] = `${args[0].slice(0, -2)}${(parseInt(args[0].slice(-2), 16) ^ 1).toString(16).padStart(2, '0')}` as Hex;
    assert.equal(await client.readContract({ address: harness.address, abi, functionName: 'verifyTable', args: altered }), false);
    for (const scalar of [0n, order, (1n << 256n) - 1n]) {
      const bad = [...args]; bad[2] = toHex(Uint8Array.from(fromHex(toHex(scalar, { size: 32 }))).reverse());
      assert.equal(await client.readContract({ address: harness.address, abi, functionName: 'verifyTable', args: bad }), false);
    }
    signatureResults.push({ signStructureBytes: signed.signStructure.length, estimateGas: gas.toString(), validAccepted: true, mutationsRejected: true });
  }
  results.push({ name, publicKey: key, protectedHeaderHash: keccak256(headers), ...(sourceCaptureSha256 ? { sourceCaptureSha256 } : {}), deployment, table, tableCodeHash: keccak256(code), tableEntriesMatched: 256, scalarCasesMatched: scalarCases.length, signatureResults });
  console.log(JSON.stringify(results.at(-1)));
}
const torsion = ed25519.Point.fromBytes(new Uint8Array(32));
const invalidKeys = [torsion, torsion.add(ed25519.Point.BASE)];
for (const point of invalidKeys) {
  const data = encodeDeployData({ abi: validatorAbi, bytecode: `0x${validatorArtifact.evm.bytecode.object}`, args: [account.address, toHex(point.toBytes()), point.toAffine().x, '0x01'] });
  await assert.rejects(client.estimateGas({ account, data }), 'small-order and mixed-torsion keys rejected');
}
const badCoordinate = encodeDeployData({ abi: validatorAbi, bytecode: `0x${validatorArtifact.evm.bytecode.object}`, args: [account.address, toHex(fixturePublicKey), ed25519.Point.fromBytes(fixturePublicKey).toAffine().x + 1n, '0x01'] });
await assert.rejects(client.estimateGas({ account, data: badCoordinate }), 'unrelated auxiliary coordinate rejected');
const evidence = { kind: 'local-onchain-table-differential-verification', timestamp: new Date().toISOString(), chainId: 31337, baseSepolia: false, publicBundlerAdmission: false, fullKernelPath: false, results, invalidKeyCasesRejected: 3, compiler: JSON.parse(readFileSync('artifacts/build.json', 'utf8')).compiler, validatorCreationCodeHash: keccak256(`0x${validatorArtifact.evm.bytecode.object}`) };
assert.ok(results.length > 0, 'At least one verifier case was selected');
mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
