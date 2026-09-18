import { ed25519 } from '@noble/curves/ed25519.js';
import { encodeFunctionData, getAddress, hexToBytes, keccak256, parseAbi, toHex, type Address, type Hex } from 'viem';
import { fromHex, parseCardanoAddress, toHex as rawHex, verifyCip8Signature, type CardanoNetwork, type CardanoWalletAdapter, type DataSignature, type VerifiedCip8 } from '@cardano-on-evm/wallet';
import { deriveTableIdentity, deriveProfileIdentity, decodeRestrictedCalls, encodeCalls, wrapRestrictedExecution, operationFromJson, operationPayload, operationToJson, profileConfigHash, tableConfigHash, validatorSignature, type Call, type Operation, type TableIdentity, type TableIdentityConfig, type ProfileIdentity, type ProfileIdentityConfig } from '@cardano-on-evm/protocol';
export { connectLace, connectEternl, connectWallet, CardanoWalletError } from '@cardano-on-evm/wallet';
export type { CardanoWalletId, CardanoWalletInjection, Cip30Api, Cip30Provider, CardanoWalletAdapter, ConnectedCardanoWallet, CardanoNetwork, CardanoCredential, DataSignature } from '@cardano-on-evm/wallet';
export * from '@cardano-on-evm/protocol';

export type AccountConfig = TableIdentityConfig | ProfileIdentityConfig;
export type ResolvedAccountConfig = Readonly<AccountConfig>;
function resolveAccountConfig(config: AccountConfig): ResolvedAccountConfig {
  if ('addressDerivationMode' in config) throw new Error('Unsupported configuration field: addressDerivationMode');
  const snapshot = { ...config };
  if ('profile' in snapshot) profileConfigHash(snapshot); else tableConfigHash(snapshot);
  return Object.freeze(snapshot);
}
export interface CardanoAccount {
  readonly profile: 'experimental-general' | 'general' | 'restricted';
  readonly cardanoAddress: string;
  readonly cardanoNetwork: CardanoNetwork;
  readonly credential: 'payment' | 'stake';
  readonly publicKey: Hex;
  readonly protectedHeaderHash: Hex;
  readonly identity: Readonly<TableIdentity | ProfileIdentity>;
  readonly config: Readonly<ResolvedAccountConfig>;
}
export function accountFromVerifiedKey(verified: VerifiedCip8, config: AccountConfig): CardanoAccount {
  const snapshot = resolveAccountConfig(config);
  const identity = Object.freeze('profile' in snapshot ? deriveProfileIdentity(toHex(verified.publicKey), toHex(verified.protectedHeaders), snapshot) : deriveTableIdentity(toHex(verified.publicKey), toHex(verified.protectedHeaders), snapshot));
  return Object.freeze({ profile: 'profile' in snapshot ? snapshot.profile : 'experimental-general', cardanoAddress: verified.address.hex, cardanoNetwork: verified.address.network, credential: verified.address.credential, publicKey: identity.publicKey, protectedHeaderHash: keccak256(verified.protectedHeaders), identity, config: snapshot });
}

export function accountFactory(account: CardanoAccount): Address {
  return 'profile' in account.config ? (account.identity as ProfileIdentity).profileFactory : account.config.kernelFactory;
}
/** Permissionless preparation, paid by an application/submitter without gaining authority. */
export function accountPreparation(account: CardanoAccount): { to: Address; data: Hex; value: bigint } {
  return 'profile' in account.config ? { to: account.config.profilePreparationFactory, data: (account.identity as ProfileIdentity).preparationData, value: 0n } : validatorPreparation(account);
}

export function validatorPreparation(account: CardanoAccount): { to: Address; data: Hex; value: bigint } {
  return { to: account.config.tableFactory, value: 0n, data: encodeFunctionData({ abi: parseAbi(['function prepare(bytes32 key,uint256 ex,bytes headers) returns (address)']), functionName: 'prepare', args: [account.publicKey, ed25519.Point.fromBytes(hexToBytes(account.publicKey), false).toAffine().x, account.identity.protectedHeaders] }) };
}
export function constructOperation(account: CardanoAccount, options: {
  calls: readonly Call[]; nonce: bigint; deploy: boolean;
  gas: { callGasLimit: bigint; verificationGasLimit: bigint; preVerificationGas: bigint };
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
}): Operation {
  const execution = encodeCalls(options.calls);
  const operation: Operation = { sender: account.identity.account, nonce: options.nonce, callData: account.profile === 'restricted' ? wrapRestrictedExecution(execution) : execution, ...(options.deploy ? { factory: accountFactory(account), factoryData: account.identity.factoryData } : {}), ...options.gas, ...options.fees, signature: '0x' };
  return operationFromJson(operationToJson(operation));
}

export async function signOperation(account: CardanoAccount, operation: Operation, wallet: CardanoWalletAdapter) {
  const config = resolveAccountConfig(account.config);
  // Copy before asynchronous wallet calls so an application cannot accidentally
  // mutate the call/fees being authorized while a wallet prompt is open.
  const unsigned = operationFromJson(operationToJson(operation));
  if (getAddress(unsigned.sender) !== getAddress(account.identity.account)) throw new Error('Operation belongs to a different Cardano account');
  if (unsigned.factory && (getAddress(unsigned.factory) !== getAddress(accountFactory(account)) || unsigned.factoryData?.toLowerCase() !== account.identity.factoryData.toLowerCase())) throw new Error('Operation uses a different deployment configuration');
  if (account.profile === 'restricted') {
    const calls = decodeRestrictedCalls(unsigned.callData);
    if (calls.some((call) => getAddress(call.target) === getAddress(account.identity.account))) throw new Error('Restricted accounts cannot call themselves');
  }
  if (await wallet.network() !== account.cardanoNetwork) throw new Error('Wallet network differs from enrollment');
  if (!(await wallet.addresses(account.credential)).some((address) => parseCardanoAddress(address, account.cardanoNetwork).hex === account.cardanoAddress)) throw new Error('Enrolled Cardano address is unavailable');
  const payload = operationPayload(unsigned, config.chainId, config.entryPoint);
  const authorization = await wallet.signData(account.cardanoAddress, fromHex(payload));
  if (await wallet.network() !== account.cardanoNetwork) throw new Error('Wallet network changed while signing');
  const verified = verifyCip8Signature(authorization, { address: account.cardanoAddress, network: account.cardanoNetwork, payload: fromHex(payload) });
  if (toHex(verified.publicKey) !== account.publicKey || keccak256(verified.protectedHeaders) !== account.protectedHeaderHash) throw new Error('Wallet key or signature header profile changed');
  return { operation: { ...unsigned, signature: validatorSignature(verified) }, authorization, payload };
}

interface Challenge {
  id: string; application: string; cardanoAddress: string; cardanoNetwork: CardanoNetwork;
  baseChainId: number; configHash: string; issuedAt: number; expiresAt: number; payloadHex: string;
}
export interface EnrollmentTransport {
  challenge(address: string): Promise<Challenge>;
  enroll(id: string, signed: DataSignature): Promise<{ identity: TableIdentity | ProfileIdentity; publicKey: string; address: string; credential: 'payment' | 'stake' }>;
}
export function httpEnrollmentTransport(baseUrl: string, fetcher: typeof fetch = fetch): EnrollmentTransport {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) throw new Error('Use HTTPS or loopback enrollment');
  async function post(path: string, body: unknown) {
    let response: Response;
    try { response = await fetcher(new URL(path, base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error' }); }
    catch { throw new Error('Enrollment transport failed'); }
    if (!response.ok) throw new Error(`Enrollment rejected the request (HTTP ${response.status})`);
    return response.json();
  }
  return { challenge: (address) => post('challenge', { address }), enroll: (id, signed) => post('enroll', { id, ...signed }) };
}

export async function enrollCardanoAccount(options: {
  wallet: CardanoWalletAdapter; transport: EnrollmentTransport; application: string;
  cardanoAddress: string; cardanoNetwork: CardanoNetwork; credential: 'payment' | 'stake';
  config: AccountConfig; now?: () => number;
}): Promise<CardanoAccount> {
  const application = new URL(options.application);
  if (!['http:', 'https:'].includes(application.protocol) || application.origin !== options.application) throw new Error('Application must be an exact HTTP(S) origin');
  const config = resolveAccountConfig(options.config);
  const claimed = parseCardanoAddress(options.cardanoAddress, options.cardanoNetwork);
  if (claimed.credential !== options.credential) throw new Error('Selected credential differs from claimed address');
  const wantedConfig = 'profile' in config ? profileConfigHash(config) : tableConfigHash(config);
  const challenge = await options.transport.challenge(claimed.hex);
  const now = (options.now ?? Date.now)();
  if (!/^[0-9a-f]{64}$/.test(challenge.id) || challenge.application !== options.application || challenge.cardanoAddress !== claimed.hex || challenge.cardanoNetwork !== options.cardanoNetwork || challenge.baseChainId !== config.chainId || challenge.configHash !== wantedConfig) throw new Error('Enrollment challenge scope differs from requested account');
  if (!Number.isSafeInteger(challenge.issuedAt) || !Number.isSafeInteger(challenge.expiresAt) || now < challenge.issuedAt || now >= challenge.expiresAt || challenge.expiresAt - challenge.issuedAt > 900000) throw new Error('Enrollment challenge has expired or invalid times');
  const expected = rawHex(new TextEncoder().encode(JSON.stringify({ domain: 'cardano-kernel:enrollment:v1', challenge: challenge.id, application: challenge.application, cardanoAddress: challenge.cardanoAddress, cardanoNetwork: challenge.cardanoNetwork, baseChainId: challenge.baseChainId, configHash: challenge.configHash, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt })));
  if (challenge.payloadHex !== expected) throw new Error('Enrollment payload differs from its declared scope');
  if (await options.wallet.network() !== options.cardanoNetwork) throw new Error('Wallet network differs from enrollment');
  if (!(await options.wallet.addresses(options.credential)).some((address) => parseCardanoAddress(address, options.cardanoNetwork).hex === claimed.hex)) throw new Error('Selected Cardano address is unavailable');
  const signed = await options.wallet.signData(claimed.hex, fromHex(expected));
  if (await options.wallet.network() !== options.cardanoNetwork) throw new Error('Wallet network changed during enrollment');
  const verified = verifyCip8Signature(signed, { address: claimed.hex, network: options.cardanoNetwork, payload: fromHex(expected) });
  const account = accountFromVerifiedKey(verified, config);
  const enrolled = await options.transport.enroll(challenge.id, signed);
  if (enrolled.publicKey !== rawHex(verified.publicKey) || enrolled.address !== claimed.hex || enrolled.credential !== claimed.credential) throw new Error('Backend enrollment identity mismatch');
  const backendIdentity = enrolled.identity as unknown as Record<string, unknown>;
  for (const [field, wanted] of Object.entries(account.identity)) {
    const actual = backendIdentity?.[field];
    if (typeof actual !== 'string' || actual.toLowerCase() !== wanted.toLowerCase()) throw new Error('SDK and backend account derivation disagree');
  }
  return account;
}
