import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const names = ['PreparedTableValidator', 'PreparedTableFactory', 'ProfileAccountFactory', 'ProfilePreparationFactory', 'RestrictedExecutionHook', 'TargetAllowlistPolicy', 'SelectorAllowlistPolicy', 'Kernel', 'KernelFactory'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function put(root, file, value) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), typeof value === 'string' ? value : JSON.stringify(value));
}
const run = (script, cwd) => execFileSync(process.execPath, [resolve('scripts', script)], { cwd, encoding: 'utf8' });

test('contract packaging removes stale generated artifacts and source trees while preserving package inputs', () => {
  const stage = mkdtempSync(join(tmpdir(), 'cardano-contract-package-build-'));
  try {
    const source = '// Generated packaging regression input.\n';
    put(stage, 'contracts/Fixture.sol', source);
    put(stage, 'vendor/sources.json', []);
    put(stage, 'LICENSE', 'source license\n');
    put(stage, 'THIRD_PARTY_NOTICES.md', 'source notices\n');
    put(stage, 'versions.json', {});
    const meta = { name: '@cardano-on-evm/contracts', version: '0.1.0', private: true };
    put(stage, 'packages/contracts/package.json', meta);
    put(stage, 'packages/contracts/README.md', 'package input\n');
    put(stage, 'artifacts/contracts.json', { 'contracts/Fixture.sol': Object.fromEntries(names.map(name => [name, {
      abi: [], evm: { bytecode: { object: '6000', linkReferences: {} }, deployedBytecode: { object: '6001', linkReferences: {}, immutableReferences: {} } },
    }])) });
    put(stage, 'artifacts/build.json', { addressDerivationMode: 'portable', compiler: 'generated-test-input', settings: { remappings: [] }, kernelSettings: {}, sourceFiles: [{ file: 'contracts/Fixture.sol', sha256: sha(source) }] });
    for (const file of ['artifacts/Unexpected.json', 'contracts/stale/tree.sol', 'vendor/stale/source.sol']) put(stage, 'packages/contracts/' + file, 'stale output');
    run('build-contract-package.mjs', stage);
    assert.deepEqual(readdirSync(join(stage, 'packages/contracts/artifacts')).sort(), names.map(name => name + '.json').sort());
    assert.deepEqual(readdirSync(join(stage, 'packages/contracts/contracts')), ['Fixture.sol']);
    assert.deepEqual(readdirSync(join(stage, 'packages/contracts/vendor')), ['sources.json']);
    assert.equal(readFileSync(join(stage, 'packages/contracts/README.md'), 'utf8'), 'package input\n');
    assert.deepEqual(JSON.parse(readFileSync(join(stage, 'packages/contracts/package.json'), 'utf8')), meta);
    const manifest = JSON.parse(readFileSync(join(stage, 'packages/contracts/manifest.json'), 'utf8'));
    assert.deepEqual(manifest.artifacts.map(item => item.name).sort(), names.toSorted());
    const exports = [...readFileSync(join(stage, 'packages/contracts/index.js'), 'utf8').matchAll(/export \{ (\w+) \};/g)].map(match => match[1]);
    assert.deepEqual(exports.sort(), [...names, 'manifest'].sort());
    put(stage, 'packages/contracts/artifacts/Unexpected.json', '{}');
    run('build-contract-package.mjs', stage);
    assert.deepEqual(readdirSync(join(stage, 'packages/contracts/artifacts')).sort(), names.map(name => name + '.json').sort());
  } finally { rmSync(stage, { recursive: true, force: true }); }
});

test('library packaging drops stale compiler output and preserves package source and metadata', () => {
  const stage = mkdtempSync(join(tmpdir(), 'cardano-library-package-build-'));
  try {
    put(stage, 'LICENSE', 'license\n');
    put(stage, 'node_modules/typescript/bin/tsc', "console.log('Version fixture compiler');\n");
    for (const name of ['wallet', 'protocol', 'enrollment', 'sdk', 'submission']) {
      put(stage, `packages/${name}/package.json`, { name: '@cardano-on-evm/' + name, version: '0.1.0' });
      put(stage, `packages/${name}/README.md`, 'readme\n');
      put(stage, `packages/${name}/src/index.ts`, 'export const fixture = true;\n');
      for (const extension of ['js', 'd.ts']) {
        put(stage, `dist/packages/${name}/src/index.${extension}`, 'export const fixture = true;\n');
        put(stage, `dist/packages/${name}/src/deleted.${extension}`, 'stale compiler output\n');
        put(stage, `packages/${name}/dist/stale.${extension}`, 'stale package output\n');
      }
    }
    run('build-packages.mjs', stage);
    for (const name of ['wallet', 'protocol', 'enrollment', 'sdk', 'submission']) {
      assert.deepEqual(readdirSync(join(stage, `packages/${name}/dist`)).sort(), ['index.d.ts', 'index.js']);
      assert.equal(readFileSync(join(stage, `packages/${name}/src/index.ts`), 'utf8'), 'export const fixture = true;\n');
      assert.equal(readFileSync(join(stage, `packages/${name}/README.md`), 'utf8'), 'readme\n');
    }
    const build = JSON.parse(readFileSync(join(stage, 'artifacts/package-build.json'), 'utf8'));
    assert.deepEqual(Object.keys(build).sort(), ['addressDerivationMode', 'arch', 'kind', 'packages', 'platform', 'typescriptVersion']);
    assert.equal(build.typescriptVersion, 'Version fixture compiler');
    assert.equal(build.platform, process.platform);
    assert.equal(build.arch, process.arch);
    assert.equal(build.addressDerivationMode, 'portable');
    assert.equal(build.packages.length, 10);
  } finally { rmSync(stage, { recursive: true, force: true }); }
});
