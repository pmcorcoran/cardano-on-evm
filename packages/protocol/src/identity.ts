import { ed25519 } from '@noble/curves/ed25519.js';
import { concatHex, encodeAbiParameters, encodeFunctionData, getAddress, getCreate2Address, hexToBytes, keccak256, parseAbi, stringToHex, zeroAddress, type Address, type Hex } from 'viem';

/** Feasibility profile. No policy or hook is installed; all powers belong to the Cardano root. */
export interface TableIdentityConfig {
  chainId: number;
  entryPoint: Address;
  kernelImplementation: Address;
  kernelFactory: Address;
  tableFactory: Address;
  validatorCreationCode: Hex;
  namespace: Hex;
  index: bigint;
}
export interface TableIdentity {
  publicKey: Hex;
  protectedHeaders: Hex;
  validator: Address;
  validatorSalt: Hex;
  validatorInitCodeHash: Hex;
  account: Address;
  accountSalt: Hex;
  actualAccountSalt: Hex;
  initializeData: Hex;
  factoryData: Hex;
  proxyInitCodeHash: Hex;
  configHash: Hex;
}
export const identityAbi = parseAbi([
  'function initialize(bytes21 rootValidator,address hook,bytes validatorData,bytes hookData,bytes[] initConfig)',
  'function createAccount(bytes data,bytes32 salt) payable returns (address)',
]);
const identityDomain = 'cardano-kernel:identity:v1:experimental-general';
const tableDomain = keccak256(stringToHex('cardano-kernel:prepared-table:v1'));
const bytes32 = (v: Hex) => { if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error('Expected bytes32'); return v; };

export function tableConfigHash(config: TableIdentityConfig): Hex {
  if ('addressDerivationMode' in config) throw new Error('Unsupported configuration field: addressDerivationMode');
  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0 || config.index < 0n || config.index >= 1n << 256n) throw new Error('Invalid identity chain or index');
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(config.validatorCreationCode)) throw new Error('Expected linked validator creation bytecode');
  const addresses = [config.entryPoint, config.kernelImplementation, config.kernelFactory, config.tableFactory].map((value) => getAddress(value));
  if (addresses.some((address) => address === zeroAddress)) throw new Error('Identity deployments cannot be zero');
  return keccak256(encodeAbiParameters([
    { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' },
  ], [keccak256(stringToHex(`${identityDomain}:portable`)), BigInt(config.chainId), addresses[0]!, addresses[1]!, addresses[2]!, addresses[3]!, keccak256(config.validatorCreationCode), bytes32(config.namespace), config.index]));
}

/** The exact 95-byte ERC-1967 clone creation code from the pinned Solady LibClone. */
export function kernelProxyInitCode(implementation: Address): Hex {
  return concatHex(['0x603d3d8160223d3973', getAddress(implementation), '0x60095155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3']).toLowerCase() as Hex;
}

export function deriveTableIdentity(publicKey: Hex, protectedHeaders: Hex, config: TableIdentityConfig): TableIdentity {
  const configHash = tableConfigHash(config);
  bytes32(publicKey);
  publicKey = publicKey.toLowerCase() as Hex; protectedHeaders = protectedHeaders.toLowerCase() as Hex;
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(protectedHeaders) || protectedHeaders.length > 514) throw new Error('Invalid protected headers');
  const point = ed25519.Point.fromBytes(hexToBytes(publicKey), false);
  if (point.isSmallOrder() || !point.isTorsionFree()) throw new Error('Unsupported key subgroup');
  const validatorSalt = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }], [tableDomain, publicKey, keccak256(protectedHeaders)]));
  const constructor = encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes' }], [config.entryPoint, publicKey, point.toAffine().x, protectedHeaders]);
  const validatorInitCodeHash = keccak256(concatHex([config.validatorCreationCode, constructor]));
  const validator = getCreate2Address({ from: config.tableFactory, salt: validatorSalt, bytecodeHash: validatorInitCodeHash });
  const initializeData = encodeFunctionData({ abi: identityAbi, functionName: 'initialize', args: [concatHex(['0x01', validator]), zeroAddress, '0x', '0x', []] }).toLowerCase() as Hex;
  // Address salt excludes chain ID and uses its own domain without a suffix.
  // The chain-bound enrollment commitment is never an address input.
  const accountSalt = keccak256(encodeAbiParameters([
    { type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' },
  ], [keccak256(stringToHex(identityDomain)), config.entryPoint, config.kernelImplementation, config.kernelFactory, config.tableFactory, keccak256(config.validatorCreationCode), config.namespace, config.index]));
  const actualAccountSalt = keccak256(concatHex([initializeData, accountSalt]));
  const proxyInitCodeHash = keccak256(kernelProxyInitCode(config.kernelImplementation));
  const account = getCreate2Address({ from: config.kernelFactory, salt: actualAccountSalt, bytecodeHash: proxyInitCodeHash });
  const factoryData = encodeFunctionData({ abi: identityAbi, functionName: 'createAccount', args: [initializeData, accountSalt] }).toLowerCase() as Hex;
  return { publicKey, protectedHeaders, validator, validatorSalt, validatorInitCodeHash, account, accountSalt, actualAccountSalt, initializeData, factoryData, proxyInitCodeHash, configHash };
}
