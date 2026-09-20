import { readFile, writeFile, mkdir, symlink, chmod, lstat, rm, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const execute = promisify(execFile), root = fileURLToPath(new URL('..', import.meta.url));
const pin = JSON.parse(await readFile(resolve(root, 'upstream.json'), 'utf8'));
const source = resolve(root, '.local', `alto-${pin.commit}`), buildTools = resolve(root, 'build-tools');
const forgeInput = process.env.FORGE_BIN ?? 'forge';
const forge = forgeInput.includes('/') ? resolve(forgeInput) : forgeInput;
const commands = [];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const run = async (command, args, options = {}) => {
  commands.push({ executable: command, args });
  let result;
  try { result = await execute(command, args, { cwd: source, maxBuffer: 32 * 1024 * 1024, ...options }); }
  catch (error) {
    await writeFile(resolve(root, '.local/source-build-error.log'), `${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message}`);
    process.stderr.write((error.stdout || error.stderr || error.message).slice(0, 10000)); throw error;
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout.trim();
};
const forgeVersion = await run(forge, ['--version']);
if (!forgeVersion.includes('1.8.1') || !forgeVersion.includes('982849d3140c01fd3b72905759581a132df7aa98')) throw new Error('Use the pinned Foundry 1.8.1 build');
const link = async (target, path) => {
  try { const stat = await lstat(path); if (!stat.isSymbolicLink()) throw new Error(`Expected build-only symlink: ${path}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(dirname(path), { recursive: true }); await symlink(target, path); }
};
await link(resolve(root, 'node_modules'), resolve(source, 'node_modules'));
for (const name of ['yargs', 'yargs-parser']) await link(resolve(buildTools, 'node_modules/@types', name), resolve(source, 'src/node_modules/@types', name));
await chmod(resolve(buildTools, 'solc-shim.mjs'), 0o755);
for (const version of ['0817', '0823', '0828']) await link('solc-shim.mjs', resolve(buildTools, `solc-${version}`));
await run(process.execPath, [resolve(root, 'scripts/prepare.mjs'), `--source=${source}`]);
const mapping = pin.sourceBuild.remappings, original = await readFile(resolve(source, mapping.sourcePath));
const replacement = await readFile(resolve(root, mapping.replacementFile));
if (sha(replacement) !== mapping.replacementSha256 || ![mapping.originalSha256, mapping.replacementSha256].includes(sha(original))) throw new Error('Compiler remappings changed outside the source-build pin');
await writeFile(resolve(source, mapping.sourcePath), replacement);
const tasks = [
  ['PimlicoSimulations', 'src/PimlicoSimulations.sol', 'london', '0828', '1000'],
  ['EPFilterOpsOverride06', 'src/v06/EntryPointFilterOpsOverride.sol', 'london', '0817', '1000000'],
  ['EPFilterOpsOverride07', 'src/v07/EntryPointFilterOpsOverride.sol', 'paris', '0823', '1000000'],
  ['EPFilterOpsOverride08', 'src/v08/EntryPointFilterOpsOverride.sol', 'cancun', '0828', '1000000'],
  ['EPFilterOpsOverride09', 'src/v09/EntryPointFilterOpsOverride.sol', 'cancun', '0828', '1000000'],
  ['EPGasEstimationOverride06', 'src/v06/EntryPointGasEstimationOverride.sol', 'london', '0817', '1000000'],
  ['EPSimulations07', 'src/v07/EntryPointSimulations.sol', 'paris', '0828', '1000'],
  ['EPSimulations08', 'src/v08/EntryPointSimulations.sol', 'cancun', '0828', '1000'],
  ['EPSimulations09', 'src/v09/EntryPointSimulations.sol', 'cancun', '0828', '1000'],
];
for (const [name, path, evm, solc, runs] of tasks) {
  console.log(`Building ${name} from pinned source`);
  await run(forge, ['build', '--root', resolve(source, 'contracts'), '--evm-version', evm, '--optimize', '--optimizer-runs', runs, '--via-ir', '--use', resolve(buildTools, `solc-${solc}`), '--out', resolve(source, 'src/contracts'), path], {
    env: { PATH: process.env.PATH, FOUNDRY_AUTO_DETECT_REMAPPINGS: 'false', FOUNDRY_CACHE_PATH: resolve(source, 'contracts/cache'), FOUNDRY_DISABLE_NIGHTLY_WARNING: '1', SVM_HOME: resolve(root, '.local/svm') },
  });
}
const artifactChecks = [];
for (const path of ['PimlicoSimulations.sol/PimlicoSimulations.json', ...['06', '07', '08', '09'].map((v) => `EntryPointFilterOpsOverride.sol/EntryPointFilterOpsOverride${v}.json`), 'EntryPointGasEstimationOverride.sol/EntryPointGasEstimationOverride06.json', ...['07', '08', '09'].map((v) => `EntryPointSimulations.sol/EntryPointSimulations${v}.json`)]) {
  const expected = JSON.parse(await readFile(resolve(root, 'node_modules/@pimlico/alto/contracts', path), 'utf8'));
  const actual = JSON.parse(await readFile(resolve(source, 'src/contracts', path), 'utf8'));
  if (expected.bytecode.object !== actual.bytecode.object || expected.deployedBytecode.object !== actual.deployedBytecode.object) throw new Error(`Rebuilt artifact differs: ${path}`);
  artifactChecks.push({ path, creationAndRuntimeMatch: true, creationSha256: sha(actual.bytecode.object) });
}
// Upstream's root build cleans esm before invoking its source package compiler.
// Only this generated directory is removed; preferred source remains intact.
await rm(resolve(source, 'src/esm'), { recursive: true, force: true });
const compiler = resolve(buildTools, 'node_modules/typescript/bin/tsc');
const compilerArgs = ['-p', resolve(source, 'src/tsconfig.json'), '--moduleResolution', 'bundler', '--rootDir', resolve(source, 'src'), '--types', 'node', '--noEmitOnError', '--pretty', 'false'];
const typescriptVersion = await run(process.execPath, [compiler, '--version']);
const effectiveTypeScriptConfiguration = JSON.parse(await run(process.execPath, [compiler, ...compilerArgs, '--showConfig']));
await run(process.execPath, [compiler, ...compilerArgs]);
await run(process.execPath, [resolve(buildTools, 'node_modules/tsc-alias/dist/bin/index.js'), '-p', resolve(source, 'src/tsconfig.json')]);
const cliVersionOutput = await run(process.execPath, [resolve(source, 'src/esm/cli/alto.js'), '--version'], { cwd: resolve(source, 'src'), env: { PATH: process.env.PATH, DOTENV_CONFIG_PATH: '/dev/null' } });
const compiledVersion = JSON.parse(await readFile(resolve(source, 'src/package.json'), 'utf8')).version;
if (compiledVersion !== pin.version) throw new Error('Rebuilt package version differs');
const compiledFiles = [];
async function inventory(directory, prefix = '') {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) await inventory(resolve(directory, entry.name), path + '/');
    else if (entry.isFile()) compiledFiles.push({ path, sha256: sha(await readFile(resolve(directory, entry.name))) });
    else throw new Error('Unexpected generated artifact type');
  }
}
await inventory(resolve(source, 'src/esm'));
const evidence = { kind: 'alto-patched-preferred-source-build', builtAt: new Date().toISOString(), commit: pin.commit, sourceArchiveSha256: pin.sourceArchiveSha256, submodules: pin.submodules, forgeVersion, nodeVersion: process.version, compiledVersion, cliVersionOutput,
  buildToolLockSha256: sha(await readFile(resolve(buildTools, 'package-lock.json'))), runtimeLockSha256: sha(await readFile(resolve(root, 'package-lock.json'))), patches: JSON.parse(await readFile(resolve(root, '.local/patch-evidence.json'), 'utf8')), commands,
  artifactChecks, compiledFiles, sourceBuildConfiguration: pin.sourceBuild, typescriptVersion, effectiveTypeScriptConfiguration,
  notes: ['Build uses pinned npm tools and the separately locked runtime dependencies, replacing vulnerable upstream pnpm 8.', 'Solc-js standard JSON compiles the same Solidity versions/settings through the pinned Forge driver.'], sourceBuildPassed: true };
await mkdir(resolve(root, '../../evidence/release'), { recursive: true });
await writeFile(resolve(root, '../../evidence/release/alto-source-build.json'), JSON.stringify(evidence, null, 2) + '\n');
await writeFile(resolve(root, '.local/source-build-manifest.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log('Preferred-source Solidity and TypeScript build passed');
