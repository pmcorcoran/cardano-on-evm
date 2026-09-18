import { bech32 } from '@scure/base';
import { blake2b } from '@noble/hashes/blake2.js';
import { equalBytes, fromHex, toHex } from './bytes.js';

export type CardanoCredential = 'payment' | 'stake';
export type CardanoNetwork = 0 | 1;
export interface CardanoAddress {
  bytes: Uint8Array;
  hex: string;
  network: CardanoNetwork;
  type: 0 | 2 | 6 | 14;
  credential: CardanoCredential;
  keyHash: Uint8Array;
}

export function parseCardanoAddress(input: string, expectedNetwork?: CardanoNetwork): CardanoAddress {
  let bytes: Uint8Array; let prefix: string | undefined;
  if (/^(addr|stake)(_test)?1/.test(input)) {
    const decoded = bech32.decode(input as `${string}1${string}`, 120);
    bytes = Uint8Array.from(bech32.fromWords(decoded.words)); prefix = decoded.prefix;
  } else bytes = fromHex(input);
  if (bytes.length === 0) throw new Error('Empty Cardano address');
  const type = bytes[0]! >> 4; const network = bytes[0]! & 15;
  if (network !== 0 && network !== 1) throw new Error('Unsupported Cardano network');
  if (expectedNetwork !== undefined && network !== expectedNetwork) throw new Error('Cardano network mismatch');
  if (type !== 0 && type !== 2 && type !== 6 && type !== 14) throw new Error('Unsupported Cardano address type');
  if (bytes.length !== (type === 0 || type === 2 ? 57 : 29)) throw new Error('Invalid Cardano address length');
  const credential = type === 14 ? 'stake' : 'payment';
  const expectedPrefix = `${credential === 'stake' ? 'stake' : 'addr'}${network === 0 ? '_test' : ''}`;
  if (prefix !== undefined && prefix !== expectedPrefix) throw new Error('Cardano address prefix mismatch');
  return { bytes, hex: toHex(bytes), network, type, credential, keyHash: bytes.slice(1, 29) };
}

export function assertAddressKey(address: CardanoAddress, publicKey: Uint8Array): void {
  if (publicKey.length !== 32 || !equalBytes(address.keyHash, blake2b(publicKey, { dkLen: 28 }))) {
    throw new Error(`Public key does not match the address ${address.credential} credential`);
  }
}
