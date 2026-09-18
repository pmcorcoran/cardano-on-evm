import type { Address, Hex } from 'viem';
import { getAddress } from 'viem';
import { decodeCalls, decodeRestrictedCalls, operationFromJson, operationHash, operationPayload } from '../../packages/protocol/src/index.js';
import { parseCardanoAddress, type CardanoNetwork, type CardanoWalletId } from '../../packages/wallet/src/index.js';

export interface LiveRequest {
  version: 1;
  id: string;
  createdAt: string;
  title: string;
  mode: 'public' | 'direct' | 'private';
  chainId: 84532;
  entryPoint: Address;
  cardanoAddress: string;
  cardanoNetwork: CardanoNetwork;
  credential: 'payment' | 'stake';
  publicKey: Hex;
  protectedHeaderHash: Hex;
  userOperationHash: Hex;
  payloadHex: Hex;
  operation: Record<string, string>;
  profile: 'experimental-general' | 'general' | 'restricted';
  profileDetails?: { name: 'general' | 'targets' | 'selectors'; factory: Address; hook: Address; policy: Address; policyConfig: Hex; policyCodeHash: Hex; profileHash: Hex };
  validator: Address;
  sourceCapture: string;
  /** Reported enrollment provider; absent in legacy requests. */
  walletId?: CardanoWalletId;
  purpose?: 'expected-policy-rejection';
}
export function checkLiveRequest(request: LiveRequest) {
  if (request.walletId !== undefined && request.walletId !== 'lace' && request.walletId !== 'eternl') throw new Error('Unsupported wallet ID');
  if (request.version !== 1 || request.chainId !== 84532 || !/^[0-9a-f]{64}$/.test(request.id) || !['experimental-general', 'general', 'restricted'].includes(request.profile) || !['public', 'direct', 'private'].includes(request.mode)) throw new Error('Unsupported live request');
  if (getAddress(request.entryPoint) !== getAddress('0x0000000071727De22E5E9d8BAf0edAc6f37da032') || !/^0x[0-9a-fA-F]{64}$/.test(request.publicKey) || !/^0x[0-9a-fA-F]{64}$/.test(request.protectedHeaderHash)) throw new Error('Invalid operation identity');
  getAddress(request.validator);
  if (parseCardanoAddress(request.cardanoAddress, request.cardanoNetwork).credential !== request.credential) throw new Error('Operation credential mismatch');
  const operation = operationFromJson(request.operation);
  if (request.purpose !== undefined && (request.purpose !== 'expected-policy-rejection' || request.profile !== 'restricted')) throw new Error('Unsupported acceptance purpose');
  if (operation.signature !== '0x' || operation.paymaster || operation.verificationGasLimit > 500_000n || operation.maxFeePerGas > 100_000_000n) throw new Error('Unsupported live experiment operation');
  if (request.profile !== 'experimental-general') {
    const details = request.profileDetails;
    if (!details || !['general', 'targets', 'selectors'].includes(details.name) || (request.profile === 'general') !== (details.name === 'general')) throw new Error('Profile review details required');
    for (const value of [details.factory, details.hook, details.policy]) getAddress(value);
    for (const value of [details.policyCodeHash, details.profileHash]) if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('Invalid profile commitment');
    if (operation.factory && getAddress(operation.factory) !== getAddress(details.factory)) throw new Error('Profile factory differs from operation');
  }
  if (request.profile === 'restricted') decodeRestrictedCalls(operation.callData); else decodeCalls(operation.callData);
  if (operationHash(operation, request.chainId, request.entryPoint) !== request.userOperationHash || operationPayload(operation, request.chainId, request.entryPoint) !== request.payloadHex) throw new Error('Operation does not match its authorization payload');
  return operation;
}
