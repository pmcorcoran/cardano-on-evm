// Rebuild the reference EntryPoint from supplied source with the core compiler.
// This does not replace or claim exact reproduction of deployed upstream code.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import solc from 'solc';

const source = 'vendor/entrypoint-v07/core/EntryPoint.sol';
const settings = { optimizer: { enabled: true, runs: 1000000 }, viaIR: true, evmVersion: 'paris', metadata: { bytecodeHash: 'none', appendCBOR: false }, remappings: ['@openzeppelin/contracts/=vendor/openzeppelin-v5.0.2/contracts/'], outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode'] } } };
const inputs = {};
const get = (path) => { const content = readFileSync(path, 'utf8'); inputs[path] = createHash('sha256').update(content).digest('hex'); return content; };
const result = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { [source]: { content: get(source) } }, settings }), { import: (path) => { try { return { contents: get(path) }; } catch { return { error: 'Missing pinned source: ' + path }; } } }));
const errors = (result.errors ?? []).filter((error) => error.severity === 'error');
if (errors.length) throw new Error(errors.map((error) => error.formattedMessage).join('\n'));
const compiled = result.contracts[source].EntryPoint;
await mkdir('artifacts', { recursive: true });
const artifact = { contractName: 'EntryPoint', sourceName: source, abi: compiled.abi, bytecode: `0x${compiled.evm.bytecode.object}`, deployedBytecode: `0x${compiled.evm.deployedBytecode.object}`, evm: compiled.evm };
await writeFile('artifacts/entrypoint-reference.json', JSON.stringify(artifact, null, 2) + '\n');
await mkdir('evidence/release', { recursive: true });
const record = { kind: 'reference-entrypoint-source-build', compiler: solc.version(), settings, sources: inputs, artifact: 'artifacts/entrypoint-reference.json', artifactSha256: createHash('sha256').update(await readFile('artifacts/entrypoint-reference.json')).digest('hex'), publishedBytecodeExactMatchClaimed: false, purpose: 'Source-only local deployment example; live checks retain the pinned deployed EntryPoint' };
await writeFile('evidence/release/entrypoint-source-build.json', JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ sourceBuildPassed: true, sources: Object.keys(inputs).length, artifact: record.artifact }));
