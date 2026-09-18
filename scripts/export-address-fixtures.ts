/** Deterministic public test inputs. Run explicitly; tests only read frozen answers. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { hexToBytes, keccak256, stringToHex, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { deriveProfileIdentity, deriveTableIdentity, encodeSelectorAllowlist, encodeTargetAllowlist, type ProfileIdentity, type ProfileIdentityConfig, type TableIdentityConfig } from '../packages/protocol/src/index.js';
import { deriveBackendProfileIdentity, deriveBackendTableIdentity } from '../packages/enrollment/src/identity.js';
import { accountFactory, accountFromVerifiedKey, accountPreparation, validatorPreparation } from '../packages/sdk/src/index.js';
import { parseCardanoAddress } from '../packages/wallet/src/index.js';
import { fixtureAddress } from '../tests/fixtures.js';

const args = process.argv.slice(2);
const checking = args.includes('--check');
const out = args.includes('--out') ? args[args.indexOf('--out') + 1]! : 'fixtures/address-derivation-v1';
assert.ok(out && args.every((arg, i) => arg === '--check' || arg === '--out' || args[i - 1] === '--out'), 'Usage: export-address-fixtures.ts [--check] [--out directory]');
const stringify = (value: unknown) => `${JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)}\n`;
const normalized = (value: unknown) => JSON.parse(stringify(value).toLowerCase());
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const addr = (n: number) => toHex(n, { size: 20 }) as Address;
const artifacts = read('artifacts/contracts.json');
const build = read('artifacts/build.json');
const artifact = (name: string): any => {
  const matches = Object.values(artifacts).flatMap((file: any) => Object.entries(file)).filter(([key]) => key === name);
  assert.equal(matches.length, 1, `Unambiguous contract: ${name}`);
  return matches[0]![1];
};
const creation = (name: string): Hex => `0x${artifact(name).evm.bytecode.object}`;
type Config = TableIdentityConfig | ProfileIdentityConfig;
type SerializedConfig = Record<string, string | number>;
type Variant = 'general' | 'targets' | 'selectors' | 'experimental-general';
type InputCase = { id: string; variant: Variant; configId: string; publicKey: Hex; protectedHeaders: Hex; category: string; overrides?: SerializedConfig };
const common = {
  chainId: 31337, entryPoint: addr(0x1101), kernelImplementation: addr(0x1102), tableFactory: addr(0x1103),
  validatorCreationCode: creation('PreparedTableValidator'), namespace: keccak256(stringToHex('cardano-kernel:public-address-fixtures:v1')), index: '0',
};
const profile = { ...common, profilePreparationFactory: addr(0x1104), profileFactoryCreationCode: creation('ProfileAccountFactory') };
const configs: Record<string, SerializedConfig> = {
  general: { ...profile, profile: 'general', policy: zeroAddress, policyCodeHash: toHex(0n, { size: 32 }), policyConfig: '0x' },
  targets: { ...profile, profile: 'restricted', policy: addr(0x1105), policyCodeHash: keccak256(`0x${artifact('TargetAllowlistPolicy').evm.deployedBytecode.object}`), policyConfig: encodeTargetAllowlist([addr(0x2202), addr(0x2201)]) },
  selectors: { ...profile, profile: 'restricted', policy: addr(0x1106), policyCodeHash: keccak256(`0x${artifact('SelectorAllowlistPolicy').evm.deployedBytecode.object}`), policyConfig: encodeSelectorAllowlist([{ target: addr(0x2201), selectors: ['0x01020304', '0x05060708'], allowEmpty: true, allowValue: false }, { target: addr(0x2202), selectors: ['0x090a0b0c'], allowEmpty: false, allowValue: true }]) },
  'experimental-general': { ...common, kernelFactory: addr(0x1107) },
};
const variants = Object.keys(configs) as Variant[];
const publicKey = (seed: number) => toHex(ed25519.getPublicKey(new Uint8Array(32).fill(seed)));
const cases: InputCase[] = [];
for (const [variantIndex, variant] of variants.entries()) {
  const base: InputCase = { id: variant, variant, configId: variant, publicKey: publicKey(41 + variantIndex), protectedHeaders: '0xa10127', category: 'profile-policy-control' };
  cases.push(base);
  if (variant === 'experimental-general') cases.push({ ...base, id: `${variant}-second-index`, category: 'index-control', overrides: { index: '1' } });
  for (const seed of [3, 19, 67, 193]) for (const length of [1, 23, 31, 32, 33, 74, 255, 256]) {
    cases.push({ ...base, id: `${variant}-key-${seed}-headers-${length}`, publicKey: publicKey(seed), protectedHeaders: toHex(new Uint8Array(length).fill(seed)), category: 'key-header-padding', overrides: { index: String(seed) } });
  }
  const boundaries: [string, SerializedConfig][] = [
    ['chain-1', { chainId: 1 }], ['chain-8453', { chainId: 8453 }], ['chain-max-safe', { chainId: Number.MAX_SAFE_INTEGER }],
    ['namespace-zero', { namespace: toHex(0n, { size: 32 }) }], ['namespace-max', { namespace: toHex((1n << 256n) - 1n, { size: 32 }) }],
    ['index-max', { index: ((1n << 256n) - 1n).toString() }], ['index-word-boundary', { index: (1n << 128n).toString() }],
    ['validator-code', { validatorCreationCode: '0x60016000' }],
    ...(variant === 'experimental-general' ? [] : [['factory-code', { profileFactoryCreationCode: '0x60026000' }]] as [string, SerializedConfig][]),
  ];
  for (const [label, overrides] of boundaries) cases.push({ ...base, id: `${variant}-${label}`, category: 'encoding-boundary', overrides });
}
assert.equal(cases.length, 168);
for (const variant of variants) {
  const base = cases.find((item) => item.id === variant)!;
  for (const length of [24, 128, 130]) cases.push({ ...base, id: `${variant}-headers-${length}`, protectedHeaders: toHex(new Uint8Array(length).fill(0xa3)), category: 'header-boundary' });
  for (const [index, field] of ['entryPoint', 'kernelImplementation', 'tableFactory', variant === 'experimental-general' ? 'kernelFactory' : 'profilePreparationFactory'].entries()) {
    cases.push({ ...base, id: `${variant}-${field}`, category: 'address-affecting-infrastructure', overrides: { [field]: addr(0x3301 + index) } });
  }
  if (variant === 'targets' || variant === 'selectors') {
    for (const length of [0, 1, 31, 32, 33, 255, 256, 16384]) cases.push({ ...base, id: `${variant}-policy-bytes-${length}`, category: 'policy-encoding-boundary', overrides: { policyConfig: toHex(new Uint8Array(length).fill(0xa7)) } });
    cases.push({ ...base, id: `${variant}-policy-address`, category: 'address-affecting-policy', overrides: { policy: addr(0x3305) } });
    cases.push({ ...base, id: `${variant}-policy-code`, category: 'address-affecting-policy', overrides: { policyCodeHash: keccak256('0x6003') } });
  }
}
const targetBase = cases.find((item) => item.id === 'targets')!;
for (const count of [1, 64]) cases.push({ ...targetBase, id: `targets-count-${count}`, category: 'policy-rule-boundary', overrides: { policyConfig: encodeTargetAllowlist(Array.from({ length: count }, (_, i) => addr(0x4400 + i))) } });
const selectorBase = cases.find((item) => item.id === 'selectors')!;
for (const count of [1, 64]) cases.push({ ...selectorBase, id: `selectors-rules-${count}`, category: 'policy-rule-boundary', overrides: { policyConfig: encodeSelectorAllowlist(Array.from({ length: count }, (_, i) => ({ target: addr(0x4400 + i), selectors: ['0x01020304'], allowEmpty: false, allowValue: false }))) } });
for (const allowEmpty of [false, true]) for (const allowValue of [false, true]) cases.push({ ...selectorBase, id: `selectors-permissions-${allowEmpty}-${allowValue}`, category: 'policy-permissions', overrides: { policyConfig: encodeSelectorAllowlist([{ target: addr(0x4400), selectors: Array.from({ length: 64 }, (_, i) => toHex(i, { size: 4 })), allowEmpty, allowValue }]) } });
cases.push({ ...selectorBase, id: 'selectors-empty-data-only', category: 'policy-permissions', overrides: { policyConfig: encodeSelectorAllowlist([{ target: addr(0x4400), selectors: [], allowEmpty: true, allowValue: false }]) } });

const invalidCases = variants.flatMap((variant) => {
  const base = cases.find((item) => item.id === variant)!;
  const torsion = ed25519.Point.fromBytes(new Uint8Array(32), false);
  return [
    { ...base, id: `${variant}-small-subgroup`, category: 'key-subgroup-rejection', publicKey: toHex(ed25519.Point.ZERO.toBytes()) },
    { ...base, id: `${variant}-order-four-subgroup`, category: 'key-subgroup-rejection', publicKey: toHex(torsion.toBytes()) },
    { ...base, id: `${variant}-mixed-subgroup`, category: 'key-subgroup-rejection', publicKey: toHex(ed25519.Point.BASE.add(torsion).toBytes()) },
    ...[0, 257].map((length) => ({ ...base, id: `${variant}-invalid-headers-${length}`, category: 'header-rejection', protectedHeaders: toHex(new Uint8Array(length).fill(0xa3)) })),
  ];
});
const inputs = { schema: 1, kind: 'generated-public-test-data', infrastructureDeploymentVerified: false, description: 'Public deterministic Ed25519 keys, synthetic infrastructure addresses and current compiled creation bytes. Raw policy-byte cases test ABI encoding, not deployed policy acceptance.', publicKeySeeds: [3, 19, 41, 42, 43, 44, 67, 193], configs, cases, invalidCases };
const resolve = (item: InputCase): Config => {
  const fields = { ...configs[item.configId], ...item.overrides };
  return { ...fields, index: BigInt(fields.index!) } as unknown as Config;
};
const raw = (value: Hex) => Uint8Array.from(Buffer.from(value.slice(2), 'hex'));
const hex = (value: Uint8Array): Hex => `0x${Buffer.from(value).toString('hex')}`;
const join = (...values: Uint8Array[]) => Uint8Array.from(Buffer.concat(values));
const word = (value: bigint) => raw(`0x${value.toString(16).padStart(64, '0')}`);
const dynamic = (value: Uint8Array) => join(word(BigInt(value.length)), value, new Uint8Array((32 - value.length % 32) % 32));
// Independent encoding for the backend's table preparation call; no protocol or
// SDK ABI helpers enter this computation.
const tablePreparationData = (item: InputCase): Hex => hex(join(keccak_256(new TextEncoder().encode('prepare(bytes32,uint256,bytes)')).slice(0, 4), raw(item.publicKey), word(ed25519.Point.fromBytes(raw(item.publicKey), false).toAffine().x), word(96n), dynamic(raw(item.protectedHeaders))));
const protocolVectors = cases.map((item) => {
  const config = resolve(item);
  const identity = 'profile' in config ? deriveProfileIdentity(item.publicKey, item.protectedHeaders, config) : deriveTableIdentity(item.publicKey, item.protectedHeaders, config);
  const key = new Uint8Array(hexToBytes(item.publicKey));
  const account = accountFromVerifiedKey({ publicKey: key, protectedHeaders: hexToBytes(item.protectedHeaders), signature: new Uint8Array(64), signStructure: new Uint8Array(), address: parseCardanoAddress(toHex(fixtureAddress(14, 0, key)), 0) }, config);
  assert.deepEqual(identity, account.identity, item.id);
  return { id: item.id, variant: item.variant, identity, factory: { to: accountFactory(account), data: identity.factoryData, value: '0' }, preparation: accountPreparation(account), validatorPreparation: validatorPreparation(account) };
});
const backendVectors = cases.map((item) => {
  const config = resolve(item);
  const identity = 'profile' in config ? deriveBackendProfileIdentity(item.publicKey, item.protectedHeaders, config) : deriveBackendTableIdentity(item.publicKey, item.protectedHeaders, config);
  const validatorPreparation = { to: config.tableFactory, data: tablePreparationData(item), value: '0' };
  return { id: item.id, variant: item.variant, identity, factory: { to: 'profile' in config ? (identity as ProfileIdentity).profileFactory : config.kernelFactory, data: identity.factoryData, value: '0' }, preparation: 'profile' in config ? { to: config.profilePreparationFactory, data: (identity as ProfileIdentity).preparationData, value: '0' } : validatorPreparation, validatorPreparation };
});
assert.deepEqual(normalized(protocolVectors), normalized(backendVectors), 'Independent backend and protocol/SDK must match every frozen field');
for (const item of invalidCases) {
  const config = resolve(item);
  for (const derive of 'profile' in config ? [deriveProfileIdentity, deriveBackendProfileIdentity] : [deriveTableIdentity, deriveBackendTableIdentity]) assert.throws(() => (derive as any)(item.publicKey, item.protectedHeaders, config), item.id);
}
const inputsText = stringify(inputs);
const vectorFiles = {
  'inputs.json': inputsText,
  'protocol-vectors.json': stringify({ schema: 1, implementation: 'protocol-sdk', inputsSha256: sha256(inputsText), vectors: protocolVectors }),
  'backend-vectors.json': stringify({ schema: 1, implementation: 'independent-enrollment-backend', inputsSha256: sha256(inputsText), vectors: backendVectors }),
};
const contractNames = ['Kernel', 'KernelFactory', 'PreparedTableFactory', 'PreparedTableValidator', 'RestrictedExecutionHook', 'TargetAllowlistPolicy', 'SelectorAllowlistPolicy', 'ProfileAccountFactory', 'ProfilePreparationFactory'];
const contractBytes = Object.fromEntries(contractNames.map((name) => {
  const value = artifact(name);
  return [name, { abiSha256: sha256(JSON.stringify(value.abi)), creationSha256: sha256(Buffer.from(value.evm.bytecode.object, 'hex')), runtimeTemplateSha256: sha256(Buffer.from(value.evm.deployedBytecode.object, 'hex')), creationKeccak256: keccak256(creation(name)) }];
}));
if (checking) {
  for (const [name, data] of Object.entries(vectorFiles)) assert.equal(readFileSync(`${out}/${name}`, 'utf8'), data, `Frozen ${name} changed`);
  const provenance = read(`${out}/provenance.json`);
  assert.deepEqual(provenance.artifacts.contracts, contractBytes, 'Compiled ABI and creation/runtime bytes must retain the checkpoint');
  for (const [name, data] of Object.entries(vectorFiles)) assert.equal(provenance.frozenFiles[name], sha256(data), `${name} provenance`);
} else {
  const sources = ['packages/protocol/src/identity.ts', 'packages/protocol/src/profiles.ts', 'packages/protocol/src/index.ts', 'packages/sdk/src/index.ts', 'packages/enrollment/src/identity.ts'];
  const provenance = { schema: 1, kind: 'generated-public-test-data', protocolBackendVectorsMatched: cases.length, subgroupAndHeaderRejections: invalidCases.length, sources: Object.fromEntries(sources.map((path) => [path, sha256(readFileSync(path))])), frozenFiles: Object.fromEntries(Object.entries(vectorFiles).map(([name, data]) => [name, sha256(data)])), artifacts: { compiler: build.compiler, settings: build.settings, kernelSettings: build.kernelSettings, compilerInputSha256: build.compilerInputSha256, kernelCompilerInputSha256: build.kernelCompilerInputSha256, sourceInventorySha256: build.sourceInventorySha256, contracts: contractBytes } };
  for (const name of [...Object.keys(vectorFiles), 'provenance.json']) assert.ok(!existsSync(`${out}/${name}`), `Refusing to overwrite frozen fixture ${out}/${name}; use --check to compare`);
  mkdirSync(out, { recursive: true });
  for (const [name, data] of Object.entries({ ...vectorFiles, 'provenance.json': stringify(provenance) })) writeFileSync(`${out}/${name}`, data, { flag: 'wx' });
}
console.log(JSON.stringify({ kind: 'generated-public-test-data', checked: checking, out, vectors: cases.length, rejectedInputs: invalidCases.length, inputsSha256: sha256(inputsText) }));
