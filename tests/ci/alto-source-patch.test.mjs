import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { patchedText } from '../../infra/bundler/src/patches.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const pin = JSON.parse(readFileSync('infra/bundler/upstream.json', 'utf8'));
const definition = pin.patches.find(patch => patch.name === 'typescript7-yargs-type');

test('Alto Argv patch is source-only, idempotent and rejects tampering or partial application', () => {
  assert.equal(definition.sourcePath, 'src/cli/alto.ts');
  assert.equal(definition.installedPath, 'esm/cli/alto.js');
  assert.match(definition.sourceSha256, /^[a-f0-9]{64}$/);
  assert.match(definition.installedSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(definition.replacements, []);
  const original = 'import yargs from "yargs"\nexport function getAltoCli(): yargs.Argv { return yargs() }\n';
  const patch = { ...definition, sourceSha256: sha(original) };
  const result = patchedText(original, patch, true);
  assert.equal(result.original, original);
  assert.equal(result.changed, 'import yargs, { type Argv } from "yargs"\nexport function getAltoCli(): Argv { return yargs() }\n');
  assert.deepEqual(patchedText(result.changed, patch, true), result);
  for (const input of [original + '// tamper', result.changed + '// tamper', ...definition.sourceReplacements.map(r => original.replace(r.find, r.replace))]) {
    assert.throws(() => patchedText(input, patch, true), /Alto patch/);
  }
  const installed = 'import yargs from "yargs";\nexport function getAltoCli() { return yargs(); }\n';
  const installedPatch = { ...definition, installedSha256: sha(installed) };
  assert.deepEqual(patchedText(installed, installedPatch), { original: installed, changed: installed });
  assert.throws(() => patchedText(installed + '// tamper', installedPatch), /Alto patch input differs/);
});
