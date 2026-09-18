import { ed25519 } from '@noble/curves/ed25519.js';
import { concatHex, encodeAbiParameters, encodeFunctionData, getAddress, getCreate2Address, getCreateAddress, hexToBytes, keccak256, parseAbi, stringToHex, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { deriveTableIdentity, identityAbi, kernelProxyInitCode, type TableIdentity, type TableIdentityConfig } from './identity.js';

/** Deployment addresses and creation code must match the verified chain manifest. */
export interface ProfileIdentityConfig extends Omit<TableIdentityConfig, 'kernelFactory'> {
  profile: 'general' | 'restricted';
  profilePreparationFactory: Address;
  profileFactoryCreationCode: Hex;
  policy: Address;
  policyConfig: Hex;
  policyCodeHash: Hex;
}
export interface ProfileIdentity extends TableIdentity {
  profileFactory: Address;
  profileFactoryInitCodeHash: Hex;
  hook: Address;
  profileHash: Hex;
  preparationData: Hex;
}
export const profileFactoryAbi = parseAbi([
  'function createAccount(bytes32 namespace,uint256 index) payable returns (address)',
  'function prepare(bytes32 key,uint256 ex,bytes headers,address policy,bytes config,bytes32 policyCodeHash) returns (address)',
]);
const domain = (name: string) => keccak256(stringToHex(`cardano-kernel:${name}:v1`));
const zeroHash = toHex(0n, { size: 32 });
export function profileConfigHash(config: ProfileIdentityConfig): Hex {
  if ('addressDerivationMode' in config) throw new Error('Unsupported configuration field: addressDerivationMode');
  if (!['general', 'restricted'].includes(config.profile) || !Number.isSafeInteger(config.chainId) || config.chainId <= 0 || config.index < 0n || config.index >= 1n << 256n) throw new Error('Invalid profile, chain or index');
  const addresses = [config.entryPoint, config.kernelImplementation, config.tableFactory, config.profilePreparationFactory].map((v) => getAddress(v));
  if (addresses.includes(zeroAddress)) throw new Error('Zero profile infrastructure');
  for (const code of [config.validatorCreationCode, config.profileFactoryCreationCode]) if (!/^0x(?:[a-fA-F0-9]{2})+$/.test(code)) throw new Error('Missing profile creation bytecode');
  for (const value of [config.policyCodeHash, config.namespace]) if (!/^0x[a-fA-F0-9]{64}$/.test(value)) throw new Error('Expected bytes32 profile input');
  if (!/^0x(?:[a-fA-F0-9]{2})*$/.test(config.policyConfig) || config.policyConfig.length > 32770) throw new Error('Invalid policy configuration bytes');
  const policy = getAddress(config.policy);
  if (config.profile === 'general' ? policy !== zeroAddress || config.policyConfig !== '0x' || config.policyCodeHash !== zeroHash : policy === zeroAddress || config.policyCodeHash === zeroHash) throw new Error('Policy does not match selected profile');
  return keccak256(encodeAbiParameters([
    { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' },
    { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' },
    { type: 'bytes32' }, { type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' },
  ], [keccak256(stringToHex('cardano-kernel:identity:v1:profile:portable')), config.profile === 'restricted' ? 1n : 0n, BigInt(config.chainId), addresses[0]!, addresses[1]!, addresses[2]!, addresses[3]!, keccak256(config.validatorCreationCode), keccak256(config.profileFactoryCreationCode), policy, config.policyCodeHash, keccak256(config.policyConfig), config.namespace, config.index]));
}

export function deriveProfileIdentity(publicKey: Hex, headers: Hex, config: ProfileIdentityConfig): ProfileIdentity {
  const configHash = profileConfigHash(config);
  // Reuse this implementation's checked-key/table derivation. Its temporary
  // general-account outputs are replaced below; no canonical factory is used.
  const base = deriveTableIdentity(publicKey, headers, { ...config, kernelFactory: config.profilePreparationFactory });
  const keyX = ed25519.Point.fromBytes(hexToBytes(publicKey), false).toAffine().x;
  const constructor = encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'address' }, { type: 'bytes' }, { type: 'bytes32' }], [config.kernelImplementation, config.tableFactory, publicKey, keyX, headers, config.policy, config.policyConfig, config.policyCodeHash]);
  const profileFactoryInitCodeHash = keccak256(concatHex([config.profileFactoryCreationCode, constructor]));
  const profileFactory = getCreate2Address({ from: config.profilePreparationFactory, salt: domain('profile-preparation'), bytecodeHash: profileFactoryInitCodeHash });
  const hook = config.profile === 'general' ? zeroAddress : getCreateAddress({ from: profileFactory, nonce: 1n });
  const initializeData = encodeFunctionData({ abi: identityAbi, functionName: 'initialize', args: [concatHex(['0x01', base.validator]), hook, '0x', '0x', []] }).toLowerCase() as Hex;
  const accountSalt = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }], [domain('profile-account'), config.namespace, config.index]));
  const actualAccountSalt = keccak256(concatHex([initializeData, accountSalt]));
  const proxyInitCodeHash = keccak256(kernelProxyInitCode(config.kernelImplementation));
  const account = getCreate2Address({ from: profileFactory, salt: actualAccountSalt, bytecodeHash: proxyInitCodeHash });
  const profileHash = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }], [domain('profile'), config.kernelImplementation, config.tableFactory, config.entryPoint, publicKey, keccak256(headers), config.policy, config.policyCodeHash, keccak256(config.policyConfig)]));
  const factoryData = encodeFunctionData({ abi: profileFactoryAbi, functionName: 'createAccount', args: [config.namespace, config.index] }).toLowerCase() as Hex;
  const preparationData = encodeFunctionData({ abi: profileFactoryAbi, functionName: 'prepare', args: [publicKey, keyX, headers, config.policy, config.policyConfig, config.policyCodeHash] }).toLowerCase() as Hex;
  return { ...base, profileFactory, profileFactoryInitCodeHash, hook, profileHash, preparationData, initializeData, accountSalt, actualAccountSalt, proxyInitCodeHash, account, factoryData, configHash };
}

export function encodeTargetAllowlist(targets: readonly Address[]): Hex {
  if (targets.length === 0 || targets.length > 64) throw new Error('Supply 1..64 targets');
  const sorted = targets.map((target) => getAddress(target)).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  if (sorted.includes(zeroAddress) || new Set(sorted).size !== sorted.length) throw new Error('Targets must be nonzero and unique');
  return encodeAbiParameters([{ type: 'address[]' }], [sorted]);
}
export interface SelectorRule { target: Address; selectors: readonly Hex[]; allowEmpty: boolean; allowValue: boolean }
export function encodeSelectorAllowlist(rules: readonly SelectorRule[]): Hex {
  if (rules.length === 0 || rules.length > 64) throw new Error('Supply 1..64 rules');
  const normalized = rules.map((rule) => {
    const selectors = rule.selectors.map((selector) => { if (!/^0x[0-9a-fA-F]{8}$/.test(selector)) throw new Error('Expected bytes4 selector'); return selector.toLowerCase() as Hex; }).sort();
    if (selectors.length > 64 || (!selectors.length && !rule.allowEmpty) || new Set(selectors).size !== selectors.length) throw new Error('Invalid selector count or duplicate selector');
    if (typeof rule.allowEmpty !== 'boolean' || typeof rule.allowValue !== 'boolean') throw new Error('Explicit empty-data and value permissions are required');
    return { ...rule, target: getAddress(rule.target), selectors };
  }).sort((a, b) => a.target.toLowerCase().localeCompare(b.target.toLowerCase()));
  if (normalized.some((r) => r.target === zeroAddress) || new Set(normalized.map((r) => r.target)).size !== normalized.length) throw new Error('Rule targets must be nonzero and unique');
  return encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'selectors', type: 'bytes4[]' }, { name: 'allowEmpty', type: 'bool' }, { name: 'allowValue', type: 'bool' }] }], [normalized]);
}
