import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';

test('controlled packaging fixtures enforce stage, evidence, archive and download gates', { timeout: 60000 }, () => {
  const output = execFileSync('python3', ['tests/ci/package-fixtures.py', '-v'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.match(output, /"attestationsVerified": false/);
  assert.match(output, /"published": false/);
});
