import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { keccak256, toFunctionSelector, type Abi } from 'viem';
import type { Artifact } from '../scripts/build-contracts.js';

const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const provenance = readJson('fixtures/address-derivation-v1/provenance.json');
const artifacts = readJson('artifacts/contracts.json') as Record<string, Record<string, Artifact>>;
const build = readJson('artifacts/build.json');
const contract = (name: string): Artifact => {
  const matches = Object.values(artifacts).flatMap((file) => Object.entries(file)).filter(([key]) => key === name);
  assert.equal(matches.length, 1, `Unambiguous contract: ${name}`);
  return matches[0]![1];
};
const names = ['Kernel', 'KernelFactory', 'PreparedTableFactory', 'PreparedTableValidator', 'RestrictedExecutionHook', 'TargetAllowlistPolicy', 'SelectorAllowlistPolicy', 'ProfileAccountFactory', 'ProfilePreparationFactory'];

test('all nine current contract ABIs and creation/runtime bytes retain the portable checkpoint', () => {
  assert.deepEqual(Object.keys(provenance.artifacts.contracts).sort(), [...names].sort());
  for (const name of names) {
    const artifact = contract(name), expected = provenance.artifacts.contracts[name];
    assert.equal(sha256(JSON.stringify(artifact.abi)), expected.abiSha256, `${name}: ABI`);
    assert.equal(sha256(Buffer.from(artifact.evm.bytecode.object, 'hex')), expected.creationSha256, `${name}: creation`);
    assert.equal(sha256(Buffer.from(artifact.evm.deployedBytecode.object, 'hex')), expected.runtimeTemplateSha256, `${name}: runtime`);
    assert.equal(keccak256(`0x${artifact.evm.bytecode.object}`), expected.creationKeccak256, `${name}: creation identity`);
  }
});

test('profile account salt domain, ABI types and factory selectors remain exact', () => {
  const abi = contract('ProfileAccountFactory').abi as Abi;
  const salt = abi.find((item) => item.type === 'function' && item.name === 'accountSalt');
  assert.ok(salt?.type === 'function');
  assert.equal(salt.stateMutability, 'pure');
  assert.deepEqual(salt.inputs.map((input) => input.type), ['bytes32', 'uint256']);
  assert.deepEqual(salt.outputs.map((output) => output.type), ['bytes32']);
  assert.equal(toFunctionSelector('createAccount(bytes32,uint256)'), '0xd7eb8e81');
  assert.equal(toFunctionSelector('prepare(bytes32,uint256,bytes,address,bytes,bytes32)'), '0x6cf980b0');
  const source = readFileSync('contracts/profiles/ProfileAccountFactory.sol', 'utf8');
  assert.match(source, /ACCOUNT_DOMAIN\s*=\s*keccak256\("cardano-kernel:profile-account:v1"\)/);
  assert.match(source, /keccak256\(abi\.encode\(ACCOUNT_DOMAIN, namespace, index\)\)/);
});

test('preparation factory embeds exact current profile creation code with unlinked immutable templates', () => {
  const account = contract('ProfileAccountFactory'), preparation = contract('ProfilePreparationFactory');
  assert.ok(preparation.evm.bytecode.object.includes(account.evm.bytecode.object));
  for (const artifact of [account, preparation]) {
    assert.deepEqual(artifact.evm.bytecode.linkReferences, {});
    assert.deepEqual(artifact.evm.deployedBytecode.linkReferences, {});
    const immutables = artifact.evm.deployedBytecode.immutableReferences;
    assert.ok(immutables && Object.keys(immutables).length > 0);
  }
});

test('compiler provenance retains pinned settings and identifies exact current source and compiler inputs', () => {
  assert.equal(build.addressDerivationMode, 'portable');
  assert.equal(build.compiler, provenance.artifacts.compiler);
  assert.deepEqual(build.settings, provenance.artifacts.settings);
  assert.deepEqual(build.kernelSettings, provenance.artifacts.kernelSettings);
  assert.equal(build.compilerInputSha256, provenance.artifacts.compilerInputSha256);
  assert.equal(build.kernelCompilerInputSha256, provenance.artifacts.kernelCompilerInputSha256);
  assert.equal(build.sourceInventorySha256, provenance.artifacts.sourceInventorySha256);
  assert.equal(sha256(JSON.stringify(build.sourceFiles)), build.sourceInventorySha256);
  for (const file of build.sourceFiles as { file: string; sha256: string }[]) assert.equal(sha256(readFileSync(file.file)), file.sha256, file.file);
});

test('contract bytecode pins preserve exact creation and runtime hashes', () => {
  const pins = readJson('fixtures/contract-bytecode-pins.json');
  for (const [name, pin] of Object.entries(pins) as [string, { creationSha256: string; runtimeTemplateSha256: string }][]) {
    const artifact = contract(name);
    assert.equal(sha256(Buffer.from(artifact.evm.bytecode.object, 'hex')), pin.creationSha256, name);
    assert.equal(sha256(Buffer.from(artifact.evm.deployedBytecode.object, 'hex')), pin.runtimeTemplateSha256, name);
  }
});
