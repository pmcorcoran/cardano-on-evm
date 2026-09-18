import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { concatBytes, encodeCbor, type Cbor } from '@cardano-on-evm/wallet';
import { deriveProfileIdentity, deriveTableIdentity, type ProfileIdentityConfig, type TableIdentityConfig } from '@cardano-on-evm/sdk';
import { PreparedTableValidator, ProfileAccountFactory } from '@cardano-on-evm/contracts';
import { keccak256, stringToHex, zeroAddress, zeroHash, toHex, type Address } from 'viem';

// Prediction only. Replace these synthetic test addresses with matching,
// verified infrastructure on each destination chain before submitting.
const address = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
const key = ed25519.getPublicKey(new Uint8Array(32).fill(71));
const credential = concatBytes(Uint8Array.of(0xe0), blake2b(key, { dkLen: 28 }));
const publicKey = toHex(key);
const headers = toHex(encodeCbor(new Map<number | string, Cbor>([[1, -8], [4, credential], ['address', credential]])));
const general: ProfileIdentityConfig = {
  profile: 'general', chainId: 31337,
  entryPoint: address(1), kernelImplementation: address(2), tableFactory: address(3),
  profilePreparationFactory: address(4), validatorCreationCode: PreparedTableValidator.bytecode,
  profileFactoryCreationCode: ProfileAccountFactory.bytecode,
  namespace: keccak256(stringToHex('portable SDK example')), index: 0n,
  policy: zeroAddress, policyCodeHash: zeroHash, policyConfig: '0x',
};
const first = deriveProfileIdentity(publicKey, headers, general);
const second = deriveProfileIdentity(publicKey, headers, { ...general, chainId: 31338 });
for (const field of ['account', 'accountSalt', 'actualAccountSalt', 'initializeData', 'factoryData', 'profileFactory', 'preparationData'] as const) assert.equal(first[field], second[field]);
assert.notEqual(first.configHash, second.configHash);

const experimental: TableIdentityConfig = { chainId: general.chainId,
  entryPoint: general.entryPoint, kernelImplementation: general.kernelImplementation, tableFactory: general.tableFactory,
  kernelFactory: address(5), validatorCreationCode: general.validatorCreationCode, namespace: general.namespace, index: general.index };
const experimentalFirst = deriveTableIdentity(publicKey, headers, experimental);
const experimentalSecond = deriveTableIdentity(publicKey, headers, { ...experimental, chainId: 31338 });
for (const field of ['account', 'accountSalt', 'actualAccountSalt', 'initializeData', 'factoryData'] as const) assert.equal(experimentalFirst[field], experimentalSecond[field]);
assert.notEqual(experimentalFirst.configHash, experimentalSecond.configHash);
console.log(JSON.stringify({ portableAddress: first.account, experimentalGeneralAddress: experimentalFirst.account,
  chainIds: [31337, 31338], enrollmentHashesDiffer: true, generatedTestData: true, predictionOnly: true }));
