import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdir, copyFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';

const root = 'packages/contracts', artifacts = JSON.parse(await readFile('artifacts/contracts.json', 'utf8'));
const build = JSON.parse(await readFile('artifacts/build.json', 'utf8'));
assert.equal(build.addressDerivationMode, 'portable', 'Rebuild current contracts before packaging this source');
const meta = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
const selected = ['PreparedTableValidator', 'PreparedTableFactory', 'ProfileAccountFactory', 'ProfilePreparationFactory', 'RestrictedExecutionHook', 'TargetAllowlistPolicy', 'SelectorAllowlistPolicy', 'Kernel', 'KernelFactory'];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
// These directories belong to this generator. Recreate them so incremental
// builds cannot preserve artifacts or source files absent from this build.
for (const directory of ['artifacts', 'contracts', 'vendor']) await rm(`${root}/${directory}`, { recursive: true, force: true });
await mkdir(`${root}/artifacts`, { recursive: true });
const records = [];
for (const name of selected) {
  const matches = Object.entries(artifacts).flatMap(([source, list]) => Object.entries(list).filter(([n]) => n === name).map(([, artifact]) => ({ source, artifact })));
  assert.equal(matches.length, 1, `Ambiguous contract artifact: ${name}`);
  const { source, artifact } = matches[0];
  assert.match(artifact.evm.bytecode.object, /^(?:[a-f0-9]{2})+$/i, `${name} creation bytecode must be linked`);
  assert.match(artifact.evm.deployedBytecode.object, /^(?:[a-f0-9]{2})+$/i, `${name} runtime must be linked`);
  assert.deepEqual(artifact.evm.bytecode.linkReferences ?? {}, {}, `${name} creation bytecode has unresolved links`);
  assert.deepEqual(artifact.evm.deployedBytecode.linkReferences ?? {}, {}, `${name} runtime has unresolved links`);
  const item = { contractName: name, sourceName: source, abi: artifact.abi,
    bytecode: `0x${artifact.evm.bytecode.object}`, deployedBytecode: `0x${artifact.evm.deployedBytecode.object}`,
    immutableReferences: artifact.evm.deployedBytecode.immutableReferences ?? {} };
  const bytes = JSON.stringify(item, null, 2) + '\n';
  await writeFile(`${root}/artifacts/${name}.json`, bytes);
  records.push({ name, source, artifact: `artifacts/${name}.json`, artifactSha256: sha(bytes),
    creationSha256: sha(Buffer.from(artifact.evm.bytecode.object, 'hex')),
    runtimeTemplateSha256: sha(Buffer.from(artifact.evm.deployedBytecode.object, 'hex')) });
}
// Include each selected contract's transitive imports under its original source
// name. Compiler input hashes verify these bytes against the build checkpoint.
const sourceHashes = new Map(build.sourceFiles.map(({ file, sha256 }) => [file, sha256]));
const included = new Map();
const remappings = build.settings.remappings.map((item) => item.split('='));
async function includeSource(file) {
  if (included.has(file)) return;
  assert.ok((file.startsWith('contracts/') || file.startsWith('vendor/')) && posix.normalize(file) === file, `Unexpected source path: ${file}`);
  const bytes = await readFile(file);
  assert.equal(sha(bytes), sourceHashes.get(file), `Source differs from compiled input: ${file}`);
  included.set(file, bytes);
  const source = bytes.toString().replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '');
  for (const match of source.matchAll(/\bimport\s+(?:[^;]*?\s+from\s*)?["']([^"']+)["']\s*;/g)) {
    const imported = match[1];
    const mapping = remappings.find(([prefix]) => imported.startsWith(prefix));
    const resolved = imported.startsWith('.') ? posix.normalize(posix.join(posix.dirname(file), imported))
      : mapping ? mapping[1] + imported.slice(mapping[0].length) : imported;
    await includeSource(resolved);
  }
}
for (const { source } of records) await includeSource(source);
const vendorRoots = new Set([...included.keys()].filter((file) => file.startsWith('vendor/')).map((file) => file.split('/').slice(0, 2).join('/')));
for (const directory of vendorRoots) for (const file of await readdir(directory)) {
  if (/^LICENSE(?:\.[^/]+)?$/i.test(file)) included.set(`${directory}/${file}`, await readFile(`${directory}/${file}`));
}
included.set('vendor/sources.json', await readFile('vendor/sources.json'));
for (const [file, bytes] of included) {
  await mkdir(posix.dirname(`${root}/${file}`), { recursive: true });
  await writeFile(`${root}/${file}`, bytes);
}
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await copyFile(file, `${root}/${file}`);
const manifest = { package: meta.name, version: meta.version, addressDerivationMode: 'portable', compiler: build.compiler,
  contractsSha256: sha(await readFile('artifacts/contracts.json')), buildSha256: sha(await readFile('artifacts/build.json')),
  compilerInputIdentity: build.sourceFiles,
  settings: build.settings, kernelSettings: build.kernelSettings, artifacts: records,
  sources: [...included].sort(([a], [b]) => a.localeCompare(b)).map(([file, bytes]) => ({ file, sha256: sha(bytes) })),
  versions: ((v) => ({ kernel: v.kernel, entryPoint: v.entryPoint, dependencyLockfile: v.dependencies, upstreamSources: v.upstreamSources }))(JSON.parse(await readFile('versions.json', 'utf8'))),
  audited: false };
await writeFile(`${root}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
await writeFile(`${root}/index.js`, selected.flatMap((name) => [
  `import ${name} from './artifacts/${name}.json' with { type: 'json' };`,
  `export { ${name} };`,
]).join('\n') + `\nimport manifest from './manifest.json' with { type: 'json' };\nexport { manifest };\n`);
await writeFile(`${root}/index.d.ts`, 'export interface ContractArtifact { readonly contractName: string; readonly sourceName: string; readonly abi: readonly any[]; readonly bytecode: `0x${string}`; readonly deployedBytecode: `0x${string}`; readonly immutableReferences: Readonly<Record<string, readonly {start: number; length: number}[]>> }\n' + selected.map((name) => `export declare const ${name}: ContractArtifact;`).join('\n') + '\nexport declare const manifest: Readonly<Record<string, unknown>>;\n');
console.log(JSON.stringify({ package: meta.name, version: meta.version, artifacts: records.length, sourceFiles: manifest.sources.length }));
