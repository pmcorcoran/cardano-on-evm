import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, linkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { keccak256, stringToHex, toHex, type Hex } from 'viem';
import { createEnrollmentService, MemoryChallengeStore } from '../packages/enrollment/src/index.js';
import { fromHex, toHex as rawHex } from '../packages/wallet/src/index.js';
import { fixtureAddress, signFixture } from './fixtures.js';
import { readWalletCapture } from '../scripts/lib/wallet-capture.js';
import { releaseEvidenceOutput } from '../scripts/lib/release-evidence.js';
import { assertLiveConfig, entryPoint, kernel, kernelFactory, matchesRuntime } from '../scripts/lib/live-context.js';
import type { TableIdentityConfig, ProfileIdentityConfig } from '../packages/protocol/src/index.js';

test('explicit wallet captures bind declared enrollment scope and both signature profiles', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wallet-capture-input-'));
  try {
    const address = rawHex(fixtureAddress(14));
    const service = createEnrollmentService({ application: 'http://127.0.0.1:4173', cardanoNetwork: 0, baseChainId: 84532, configHash: keccak256(stringToHex('public capture control')), store: new MemoryChallengeStore(), now: () => 1000, deriveIdentity: (verified) => ({ publicKey: rawHex(verified.publicKey) }) });
    const challenge = await service.issue(address), payload = new Uint8Array(32).fill(0x42);
    const capture = { testData: true, enrollment: { challenge, signed: signFixture(fromHex(challenge.payloadHex), fixtureAddress(14), undefined, true) }, operation: { payloadHex: rawHex(payload), signed: signFixture(payload, fixtureAddress(14), undefined, true) } };
    const path = join(directory, 'capture.json'), save = (value: unknown) => writeFileSync(path, JSON.stringify(value));
    save(capture);
    const checked = readWalletCapture(path);
    assert.equal(toHex(checked.operation!.publicKey), toHex(checked.enrollment.publicKey));
    assert.match(checked.sha256, /^[a-f0-9]{64}$/);
    for (const change of [{ application: 'https://different.example' }, { baseChainId: 31337 }, { configHash: keccak256('0x01') }, { cardanoNetwork: 1 }, { expiresAt: challenge.issuedAt + 900001 }]) {
      save({ ...capture, enrollment: { ...capture.enrollment, challenge: { ...challenge, ...change } } });
      assert.throws(() => readWalletCapture(path), /scope|lifetime/);
    }
    save({ ...capture, operation: { ...capture.operation, signed: signFixture(payload, fixtureAddress(14)) } });
    assert.throws(() => readWalletCapture(path), /protected-header profiles differ/);
    save({ ...capture, operation: { ...capture.operation, payloadHex: '00' } });
    assert.throws(() => readWalletCapture(path), /payload/i);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('fresh report paths preserve input files and reject output aliases and links', () => {
  const directory = mkdtempSync(join(tmpdir(), 'report-output-input-'));
  try {
    const input = join(directory, 'manifest.json'); writeFileSync(input, '{"testData":true}');
    const output = join(directory, 'reports', 'result.json');
    assert.equal(releaseEvidenceOutput(output, [input]), output);
    writeFileSync(output, '{}', { flag: 'wx' });
    assert.throws(() => releaseEvidenceOutput(output, [input]), /already exists/);
    assert.throws(() => releaseEvidenceOutput(input, [input]), /replace an input/);
    const symbolic = join(directory, 'symbolic.json'); symlinkSync(input, symbolic);
    assert.throws(() => releaseEvidenceOutput(symbolic, [input]), /symbolic or hard link/);
    const hard = join(directory, 'hard.json'); linkSync(input, hard);
    assert.throws(() => releaseEvidenceOutput(hard, [input]), /symbolic or hard link/);
    mkdirSync(join(directory, 'real')); symlinkSync(join(directory, 'real'), join(directory, 'alias'));
    assert.throws(() => releaseEvidenceOutput(join(directory, 'alias', 'result.json'), [input]), /symbolic links/);
    assert.throws(() => releaseEvidenceOutput(join(directory, 'result.txt'), [input]), /JSON/);
    assert.equal(readFileSync(input, 'utf8'), '{"testData":true}');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('runtime matching cannot mask missing bytes or changes outside immutable fields', () => {
  const artifact = { evm: { deployedBytecode: { object: '60000055', immutableReferences: { slot: [{ start: 1, length: 2 }] } } } } as any;
  assert.equal(matchesRuntime('0x60123455', artifact), true);
  for (const code of ['0x', '0x60', '0x6012345500', '0x60123454', '0xzz123455']) assert.equal(matchesRuntime(code as Hex, artifact), false, code);
});

test('current account inputs must match every checked public infrastructure address', () => {
  const inputs = JSON.parse(readFileSync('fixtures/address-derivation-v1/inputs.json', 'utf8'));
  const infrastructure = { tableFactory: toHex(0x1103, { size: 20 }), profilePreparationFactory: toHex(0x1104, { size: 20 }) };
  for (const name of ['general', 'targets', 'selectors', 'experimental-general']) {
    const config = { ...inputs.configs[name], chainId: 84532, entryPoint, kernelImplementation: kernel, ...(name === 'experimental-general' ? { kernelFactory } : {}), index: 0n } as TableIdentityConfig | ProfileIdentityConfig;
    assert.doesNotThrow(() => assertLiveConfig(config, infrastructure));
    for (const change of [{ chainId: 31337 }, { entryPoint: toHex(0x7701, { size: 20 }) }, { kernelImplementation: toHex(0x7702, { size: 20 }) }, { tableFactory: toHex(0x7703, { size: 20 }) }, 'profile' in config ? { profilePreparationFactory: toHex(0x7704, { size: 20 }) } : { kernelFactory: toHex(0x7705, { size: 20 }) }]) assert.throws(() => assertLiveConfig({ ...config, ...change }, infrastructure), /differs|Base Sepolia/);
  }
});
