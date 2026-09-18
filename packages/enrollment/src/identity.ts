import { keccak_256 } from '@noble/hashes/sha3.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import type { TableIdentityConfig, TableIdentity } from '@cardano-on-evm/protocol';
import type { ProfileIdentityConfig, ProfileIdentity } from '@cardano-on-evm/protocol';

// Independent backend encoding implementation. It deliberately uses neither
// viem ABI/CREATE2 helpers nor the SDK's derivation functions at runtime.
const bytes = (value: string) => {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error('Invalid hex bytes');
  return Uint8Array.from(value.slice(2).match(/../g) ?? [], (v) => parseInt(v, 16));
};
const hex = (value: Uint8Array): `0x${string}` => `0x${Array.from(value, (v) => v.toString(16).padStart(2, '0')).join('')}`;
const join = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, v) => n + v.length, 0)); let i = 0; for (const part of parts) { out.set(part, i); i += part.length; } return out; };
const hash = (value: Uint8Array) => keccak_256(value);
const word = (number: bigint) => { if (number < 0n || number >= 1n << 256n) throw new Error('Invalid uint256'); return bytes(`0x${number.toString(16).padStart(64, '0')}`); };
const fixed = (value: string, length: number) => { const decoded = bytes(value); if (decoded.length !== length) throw new Error('Wrong fixed-byte length'); return decoded; };
const address = (value: string) => { const decoded = fixed(value, 20); if (decoded.every((v) => v === 0)) throw new Error('Zero identity deployment'); return join(new Uint8Array(12), decoded); };
const dynamic = (value: Uint8Array) => join(word(BigInt(value.length)), value, new Uint8Array((32 - value.length % 32) % 32));
const textHash = (value: string) => hash(new TextEncoder().encode(value));
const create2 = (factory: string, salt: Uint8Array, initHash: Uint8Array) => hex(hash(join(Uint8Array.of(255), fixed(factory, 20), salt, initHash)).slice(12));
export function backendTableConfigHash(config: TableIdentityConfig): `0x${string}` {
  if ('addressDerivationMode' in config) throw new Error('Unsupported configuration field: addressDerivationMode');
  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0) throw new Error('Invalid identity chain');
  const creationCode = bytes(config.validatorCreationCode); if (!creationCode.length) throw new Error('Missing validator creation code');
  return hex(hash(join(textHash('cardano-kernel:identity:v1:experimental-general:portable'), word(BigInt(config.chainId)), address(config.entryPoint), address(config.kernelImplementation), address(config.kernelFactory), address(config.tableFactory), hash(creationCode), fixed(config.namespace, 32), word(config.index))));
}

export function deriveBackendTableIdentity(publicKey: `0x${string}`, protectedHeaders: `0x${string}`, config: TableIdentityConfig): TableIdentity {
  const configHashBytes = bytes(backendTableConfigHash(config));
  publicKey = publicKey.toLowerCase() as `0x${string}`; protectedHeaders = protectedHeaders.toLowerCase() as `0x${string}`;
  const key = fixed(publicKey, 32); const headers = bytes(protectedHeaders);
  if (!headers.length || headers.length > 256 || !Number.isSafeInteger(config.chainId) || config.chainId <= 0) throw new Error('Invalid identity input');
  const point = ed25519.Point.fromBytes(key, false);
  if (point.isSmallOrder() || !point.isTorsionFree()) throw new Error('Unsupported key subgroup');
  const creationCode = bytes(config.validatorCreationCode); if (!creationCode.length) throw new Error('Missing validator creation code');
  // Enrollment binds the chain; address salt has a distinct, unsuffixed domain
  // and no chain ID word. Keep this independent ABI encoding explicit.
  const accountSaltBytes = hash(join(textHash('cardano-kernel:identity:v1:experimental-general'), address(config.entryPoint), address(config.kernelImplementation), address(config.kernelFactory), address(config.tableFactory), hash(creationCode), fixed(config.namespace, 32), word(config.index)));
  const x = recoverX(key);
  const validatorSaltBytes = hash(join(textHash('cardano-kernel:prepared-table:v1'), key, hash(headers)));
  const constructor = join(address(config.entryPoint), key, word(x), word(128n), dynamic(headers));
  const validatorInitCodeHashBytes = hash(join(creationCode, constructor));
  const validator = create2(config.tableFactory, validatorSaltBytes, validatorInitCodeHashBytes);
  // initialize(bytes21,address,bytes,bytes,bytes[]): five head words; the three
  // dynamic values are empty and therefore each occupies one tail word.
  const initialize = join(textHash('initialize(bytes21,address,bytes,bytes,bytes[])').slice(0, 4), Uint8Array.of(1), fixed(validator, 20), new Uint8Array(11), word(0n), word(160n), word(192n), word(224n), word(0n), word(0n), word(0n));
  const actualSaltBytes = hash(join(initialize, accountSaltBytes));
  const proxyCode = join(bytes('0x603d3d8160223d3973'), fixed(config.kernelImplementation, 20), bytes('0x60095155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3'));
  const proxyHashBytes = hash(proxyCode);
  const factoryDataBytes = join(textHash('createAccount(bytes,bytes32)').slice(0, 4), word(64n), accountSaltBytes, dynamic(initialize));
  return { publicKey, protectedHeaders, validator, validatorSalt: hex(validatorSaltBytes), validatorInitCodeHash: hex(validatorInitCodeHashBytes), account: create2(config.kernelFactory, actualSaltBytes, proxyHashBytes), accountSalt: hex(accountSaltBytes), actualAccountSalt: hex(actualSaltBytes), initializeData: hex(initialize), factoryData: hex(factoryDataBytes), proxyInitCodeHash: hex(proxyHashBytes), configHash: hex(configHashBytes) };
}

// Independent p = 5 (mod 8) coordinate recovery, also used for profile creation.
function recoverX(key: Uint8Array): bigint {
  const point = ed25519.Point.fromBytes(key, false);
  if (point.isSmallOrder() || !point.isTorsionFree()) throw new Error('Unsupported key subgroup');
  const p = (1n << 255n) - 19n; const mod = (v: bigint) => (v % p + p) % p;
  const pow = (v: bigint, n: bigint) => { let r = 1n; v = mod(v); while (n) { if (n & 1n) r = mod(r * v); v = mod(v * v); n >>= 1n; } return r; };
  let compressed = 0n; for (let i = 31; i >= 0; i--) compressed = (compressed << 8n) | BigInt(key[i]!);
  const sign = compressed >> 255n; const y = compressed & ((1n << 255n) - 1n);
  const d = mod(-121665n * pow(121666n, p - 2n));
  const x2 = mod((y * y - 1n) * pow(d * y * y + 1n, p - 2n));
  let x = pow(x2, (p + 3n) / 8n); if (mod(x * x) !== x2) x = mod(x * pow(2n, (p - 1n) / 4n));
  if ((x & 1n) !== sign) x = p - x;
  if (mod(x * x) !== x2 || x !== point.toAffine().x) throw new Error('Invalid compressed key');
  return x;
}

const policyWord = (value: string) => join(new Uint8Array(12), fixed(value, 20));
export function backendProfileConfigHash(config: ProfileIdentityConfig): `0x${string}` {
  if ('addressDerivationMode' in config) throw new Error('Unsupported configuration field: addressDerivationMode');
  if (!['general', 'restricted'].includes(config.profile) || !Number.isSafeInteger(config.chainId) || config.chainId <= 0) throw new Error('Invalid profile or chain');
  const policy = fixed(config.policy, 20); const codeHash = fixed(config.policyCodeHash, 32); const policyConfig = bytes(config.policyConfig);
  const general = config.profile === 'general';
  if (policyConfig.length > 16384 || (general ? policy.some(Boolean) || codeHash.some(Boolean) || policyConfig.length > 0 : !policy.some(Boolean) || !codeHash.some(Boolean))) throw new Error('Profile policy mismatch');
  const validatorCode = bytes(config.validatorCreationCode); const factoryCode = bytes(config.profileFactoryCreationCode);
  if (!validatorCode.length || !factoryCode.length) throw new Error('Missing profile creation bytecode');
  return hex(hash(join(textHash('cardano-kernel:identity:v1:profile:portable'), word(general ? 0n : 1n), word(BigInt(config.chainId)), address(config.entryPoint), address(config.kernelImplementation), address(config.tableFactory), address(config.profilePreparationFactory), hash(validatorCode), hash(factoryCode), policyWord(config.policy), codeHash, hash(policyConfig), fixed(config.namespace, 32), word(config.index))));
}

export function deriveBackendProfileIdentity(publicKey: `0x${string}`, protectedHeaders: `0x${string}`, config: ProfileIdentityConfig): ProfileIdentity {
  const configHash = backendProfileConfigHash(config);
  const base = deriveBackendTableIdentity(publicKey, protectedHeaders, { ...config, kernelFactory: config.profilePreparationFactory });
  const key = fixed(publicKey, 32); const headers = bytes(protectedHeaders); const x = recoverX(key);
  const headerTail = dynamic(headers); const configTail = dynamic(bytes(config.policyConfig));
  const ctor = join(address(config.kernelImplementation), address(config.tableFactory), key, word(x), word(256n), policyWord(config.policy), word(256n + BigInt(headerTail.length)), fixed(config.policyCodeHash, 32), headerTail, configTail);
  const profileFactoryInitCodeHash = hex(hash(join(bytes(config.profileFactoryCreationCode), ctor)));
  const profileFactory = create2(config.profilePreparationFactory, textHash('cardano-kernel:profile-preparation:v1'), bytes(profileFactoryInitCodeHash));
  const hook = config.profile === 'general' ? hex(new Uint8Array(20)) : hex(hash(join(bytes('0xd694'), fixed(profileFactory, 20), Uint8Array.of(1))).slice(12));
  const initialize = join(textHash('initialize(bytes21,address,bytes,bytes,bytes[])').slice(0, 4), Uint8Array.of(1), fixed(base.validator, 20), new Uint8Array(11), policyWord(hook), word(160n), word(192n), word(224n), word(0n), word(0n), word(0n));
  const accountSalt = hash(join(textHash('cardano-kernel:profile-account:v1'), fixed(config.namespace, 32), word(config.index)));
  const actualAccountSalt = hash(join(initialize, accountSalt));
  const account = create2(profileFactory, actualAccountSalt, bytes(base.proxyInitCodeHash));
  const profileHash = hex(hash(join(textHash('cardano-kernel:profile:v1'), address(config.kernelImplementation), address(config.tableFactory), address(config.entryPoint), key, hash(headers), policyWord(config.policy), fixed(config.policyCodeHash, 32), hash(bytes(config.policyConfig)))));
  const factoryData = hex(join(textHash('createAccount(bytes32,uint256)').slice(0, 4), fixed(config.namespace, 32), word(config.index)));
  const preparationData = hex(join(textHash('prepare(bytes32,uint256,bytes,address,bytes,bytes32)').slice(0, 4), key, word(x), word(192n), policyWord(config.policy), word(192n + BigInt(headerTail.length)), fixed(config.policyCodeHash, 32), headerTail, configTail));
  return { ...base, profileFactory, profileFactoryInitCodeHash, hook, profileHash, preparationData, account, accountSalt: hex(accountSalt), actualAccountSalt: hex(actualAccountSalt), initializeData: hex(initialize), factoryData, configHash };
}
