import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { encodeFunctionData, keccak256, toHex, type Address, type Abi } from 'viem';
import { liveContext, entryPoint, json, matchesRuntime } from '../lib/live-context.js';
import { readWalletCapture } from '../lib/wallet-capture.js';
import { releaseEvidenceOutput } from '../lib/release-evidence.js';

let stage = 'verify local capture';
let context: Awaited<ReturnType<typeof liveContext>> | undefined;
try {
  const { values } = parseArgs({ options: { infrastructure: { type: 'string' }, journal: { type: 'string' }, differential: { type: 'string' }, out: { type: 'string' }, capture: { type: 'string' }, 'key-file': { type: 'string' }, 'key-variable': { type: 'string', default: 'SUBMITTER_PRIVATE_KEY' }, send: { type: 'boolean', default: false } } });
  if (!values.infrastructure || !values.journal || !values.differential || !values.out || !values.capture || !values['key-file']) throw new Error('Capture and key path required');
  const { challenge, enrollment, operation, sha256: captureSha256 } = readWalletCapture(values.capture);
  if (!operation || challenge.baseChainId !== 84532) throw new Error('A Base Sepolia wallet-format capture with both signatures is required');
  if (operation.address.credential !== 'stake' || operation.address.type !== 14 || operation.protectedHeaders.length !== 74) throw new Error('This live experiment requires the explicit stake profile');
  const key = toHex(operation.publicKey); const headers = toHex(operation.protectedHeaders);
  if (toHex(enrollment.publicKey) !== key || toHex(enrollment.protectedHeaders) !== headers) throw new Error('Capture profiles differ');
  const point = ed25519.Point.fromBytes(operation.publicKey); const ex = point.toAffine().x;
  const differential = JSON.parse(readFileSync(values.differential, 'utf8'));
  const checked = differential.results?.filter((item: any) => item.sourceCaptureSha256 === captureSha256 && item.publicKey === key && item.protectedHeaderHash === keccak256(headers));
  if (differential.kind !== 'local-onchain-table-differential-verification' || differential.chainId !== 31337 || differential.invalidKeyCasesRejected !== 3 || checked?.length !== 1 || checked[0].tableEntriesMatched !== 256 || checked[0].scalarCasesMatched < 16 || checked[0].signatureResults.length !== 2 || !checked[0].signatureResults.every((row: any) => row.validAccepted === true && row.mutationsRejected === true)) throw new Error('Independent table verification must match the capture bytes, key, headers and all controls');
  const expectedTableHash = checked[0].tableCodeHash;
  if (!/^0x[0-9a-f]{64}$/.test(expectedTableHash)) throw new Error('Independent table hash is missing');
  const output = releaseEvidenceOutput(values.out, [values.capture, values.differential, values.infrastructure, values.journal, values['key-file']]);
  stage = 'check network and pinned contracts';
  context = await liveContext(values['key-file'], values['key-variable']!, { manifest: values.infrastructure, journal: values.journal, independentSubmitter: true });
  const { client, find, tableFactory, transact } = context;
  const factoryAbi = find('PreparedTableFactory').abi as Abi; const moduleArtifact = find('PreparedTableValidator'); const abi = moduleArtifact.abi as Abi;
  if (differential.validatorCreationCodeHash !== keccak256(`0x${moduleArtifact.evm.bytecode.object}`)) throw new Error('Independent table verification used different validator bytes');
  const args = [key, ex, headers] as const;
  const validator = await client.readContract({ address: tableFactory, abi: factoryAbi, functionName: 'getAddress', args }) as Address;
  stage = 'prepare immutable stake validator';
  const receipt = await transact(`prepare-stake-${challenge.id}`, { to: tableFactory, data: encodeFunctionData({ abi: factoryAbi, functionName: 'prepare', args }) }, values.send);
  if (receipt) {
    stage = 'verify prepared validator and all table entries';
    const code = await client.getCode({ address: validator, blockNumber: receipt.blockNumber }); if (!code || !matchesRuntime(code, moduleArtifact)) throw new Error('Validator runtime differs from the build');
    const read = (functionName: string) => { stage = `verify validator ${functionName}`; return client.readContract({ address: validator, abi, functionName, blockNumber: receipt.blockNumber }); };
    if (((await read('entryPoint')) as Address).toLowerCase() !== entryPoint.toLowerCase() || await read('publicKey') !== key || await read('protectedHeaderHash') !== keccak256(headers)) throw new Error('Validator identity differs');
    const table = await read('curveTable') as Address; const tableCode = await client.getCode({ address: table, blockNumber: receipt.blockNumber });
    stage = 'compare independent curve table hash';
    if (!tableCode || keccak256(tableCode) !== expectedTableHash) throw new Error('Table differs from independent verification');
    const p = (1n << 255n) - 19n; const mod = (v: bigint) => (v % p + p) % p;
    const inverse = (value: bigint) => { let v = mod(value), n = p - 2n, out = 1n; while (n) { if (n & 1n) out = mod(out * v); v = mod(v * v); n >>= 1n; } return out; };
    const { x, y } = point.toAffine();
    const wx = mod(0x2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad2451n + (1n + y) * inverse(1n - y));
    const wy = mod(0x70d9120b9f5ff9442d84f723fc03b0813a5e2c2eb482e57d3391fb5500ba81e7n * (1n + y) * inverse((1n - y) * x));
    if (await read('keyWx') !== wx || await read('keyWy') !== wy) throw new Error('Auxiliary coordinate mismatch');
    stage = 'save verified preparation evidence';
    const evidence = { kind: 'base-sepolia-stake-validator-preparation', timestamp: new Date().toISOString(), chainId: 84532, capture: values.capture, captureSha256, credential: 'stake', addressType: 14, publicKey: key, protectedHeaders: headers, protectedHeaderBytes: operation.protectedHeaders.length, entryPoint, tableFactory, validator, validatorRuntimeHash: keccak256(code), table, tableRuntimeHash: keccak256(tableCode), runtimeAndAllImmutablesChecked: true, tableMatchesIndependent256PointCalculation: true, receipt, publicBundlerAdmission: false, liveAccountExecuted: false };
    const file = output; mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, json(evidence), { flag: 'wx' });
    console.log(json({ file, validator, table, transactionHash: receipt.transactionHash, gasUsed: receipt.gasUsed }));
  }
} catch {
  console.error(`Stake preparation failed during: ${stage}. Secrets and RPC configuration were withheld; any transaction hash remains in the local journal.`); process.exitCode = 1;
} finally { context?.release(); }
