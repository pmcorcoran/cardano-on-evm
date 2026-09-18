import { readdir, readFile, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// tsc type-checks the complete workspace and emits JS/declarations. Each package
// receives only its own output; sibling imports use public package specifiers.
const packages = ['wallet', 'protocol', 'enrollment', 'sdk', 'submission'];
const manifest = [];
for (const name of packages) {
  const root = `packages/${name}`, meta = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
  await rm(`${root}/dist`, { recursive: true, force: true });
  await mkdir(`${root}/dist`, { recursive: true });
  const sourceNames = new Set((await readdir(`${root}/src`)).filter((file) => file.endsWith('.ts')).map((file) => file.slice(0, -3)));
  for (const file of await readdir(`dist/${root}/src`)) {
    if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue;
    // tsc can leave output for deleted source files in the workspace build tree.
    if (!sourceNames.has(file.replace(/\.(?:d\.ts|js)$/, ''))) continue;
    const content = await readFile(`dist/${root}/src/${file}`, 'utf8');
    if (/from\s+['"]\.\.\/\.\.\//.test(content)) throw new Error('A package reaches outside its own installation');
    await writeFile(`${root}/dist/${file}`, content);
    manifest.push({ package: meta.name, version: meta.version, file: `dist/${file}`, sha256: createHash('sha256').update(content).digest('hex') });
  }
  await copyFile('LICENSE', `${root}/LICENSE`);
}
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/package-build.json', JSON.stringify({ kind: 'compiled-esm-and-types', addressDerivationMode: 'portable', packages: manifest }, null, 2) + '\n');
console.log(`Built ${packages.length} ESM packages and declarations; no private bundler dependency.`);
