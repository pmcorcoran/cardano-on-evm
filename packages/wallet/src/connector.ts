import { parseCardanoAddress, type CardanoNetwork } from './address.js';
import { toHex } from './bytes.js';
import { verifyCip8Signature, type DataSignature } from './cip8.js';

export type CardanoWalletId = 'lace' | 'eternl';
export interface Cip30Api {
  getNetworkId(): Promise<number>;
  getChangeAddress(): Promise<string>;
  getUsedAddresses(): Promise<string[]>;
  getRewardAddresses(): Promise<string[]>;
  signData(address: string, payload: string): Promise<DataSignature>;
}
export interface Cip30Provider { name: string; apiVersion: string; enable(): Promise<Cip30Api> }
export type CardanoWalletInjection = Partial<Record<CardanoWalletId, Cip30Provider>>;
export interface CardanoWalletAdapter {
  name: string;
  network(): Promise<number>;
  addresses(credential: 'payment' | 'stake'): Promise<string[]>;
  signData(address: string, payload: Uint8Array): Promise<DataSignature>;
}
export interface ConnectedCardanoWallet extends CardanoWalletAdapter {
  readonly walletId: CardanoWalletId;
  /** CIP-30 API version, not the installed extension release. */
  readonly apiVersion: string;
}

export class CardanoWalletError extends Error {
  constructor(message: string, readonly walletId: CardanoWalletId, readonly reconnectRequired: boolean, readonly code?: number, cause?: unknown) {
    super(message, { cause }); this.name = 'CardanoWalletError';
  }
}

export async function connectWallet(
  injection: CardanoWalletInjection, walletId: CardanoWalletId, expectedNetwork: CardanoNetwork,
): Promise<ConnectedCardanoWallet> {
  if (walletId !== 'lace' && walletId !== 'eternl') throw new Error('Unsupported Cardano wallet ID');
  if (expectedNetwork !== 0 && expectedNetwork !== 1) throw new Error('Unsupported Cardano network');
  const label = walletId === 'lace' ? 'Lace' : 'Eternl', provider = injection[walletId];
  if (!provider) throw new CardanoWalletError(`${label} is not installed or available to this page`, walletId, true);
  let invalid = false;
  const reconnect = (message: string): never => { invalid = true; throw new CardanoWalletError(`${label}: ${message}. Reconnect ${label}.`, walletId, true); };
  async function call<T>(method: string, fn: () => Promise<T>): Promise<T> {
    if (invalid) reconnect('Connection is no longer valid');
    try { return await fn(); }
    catch (cause) {
      const error = cause && typeof cause === 'object' ? cause as { code?: unknown; info?: unknown } : undefined;
      const code = typeof error?.code === 'number' ? error.code : undefined;
      const reconnectRequired = code === -3 || code === -4;
      if (reconnectRequired) invalid = true;
      const messages: Record<number, string> = { [-1]: 'Invalid wallet request', [-2]: 'Wallet internal error', [-3]: 'Wallet access was refused or lost', [-4]: 'Wallet account changed', 1: 'Wallet could not sign with this key', 2: 'Address does not have a signing key', 3: 'Signing declined; you can retry' };
      const detail = typeof error?.info === 'string' ? error.info : cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
      throw new CardanoWalletError(`${label} ${method}: ${code === undefined ? 'Wallet request failed' : messages[code] ?? `Wallet error ${code}`}${detail ? ` (${detail})` : ''}.${reconnectRequired ? ` Reconnect ${label}.` : ''}`, walletId, reconnectRequired, code, cause);
    }
  }
  const api = await call('connection', () => provider.enable());
  async function checkNetwork(): Promise<number> {
    const network = await call('network', () => api.getNetworkId());
    if (network !== expectedNetwork) reconnect('Wallet network changed or does not match enrollment');
    return network;
  }
  async function addresses(credential: 'payment' | 'stake'): Promise<string[]> {
    if (credential !== 'payment' && credential !== 'stake') throw new Error('Choose an explicit payment or stake credential');
    await checkNetwork();
    const candidates = credential === 'stake'
      ? await call('reward addresses', () => api.getRewardAddresses())
      : [await call('change address', () => api.getChangeAddress()), ...await call('used addresses', () => api.getUsedAddresses())];
    await checkNetwork();
    return [...new Set(candidates.map((value) => {
      const parsed = parseCardanoAddress(value, expectedNetwork);
      if (parsed.credential !== credential) reconnect('Wallet returned an address for a different credential');
      return parsed.hex;
    }))];
  }
  await checkNetwork();
  return {
    name: provider.name, walletId, apiVersion: provider.apiVersion, network: checkNetwork, addresses,
    async signData(address, payload) {
      const bytes = Uint8Array.from(payload), parsed = parseCardanoAddress(address, expectedNetwork);
      if (!(await addresses(parsed.credential)).includes(parsed.hex)) reconnect('Selected Cardano address is unavailable; wallet account changed');
      const signed = await call('signing', () => api.signData(parsed.hex, toHex(bytes)));
      if (!(await addresses(parsed.credential)).includes(parsed.hex)) reconnect('Wallet account changed while signing');
      verifyCip8Signature(signed, { address: parsed.hex, network: expectedNetwork, payload: bytes });
      return signed;
    },
  };
}

export function connectEternl(injection: CardanoWalletInjection, expectedNetwork: CardanoNetwork): Promise<ConnectedCardanoWallet> {
  return connectWallet(injection, 'eternl', expectedNetwork);
}
