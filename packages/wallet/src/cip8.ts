import { ed25519 } from '@noble/curves/ed25519.js';
import { assertAddressKey, parseCardanoAddress, type CardanoNetwork } from './address.js';
import { decodeCbor, encodeCbor, type Cbor } from './cbor.js';
import { equalBytes, fromHex } from './bytes.js';

export interface DataSignature { signature: string; key: string }
export interface VerifiedCip8 {
  publicKey: Uint8Array;
  protectedHeaders: Uint8Array;
  signature: Uint8Array;
  signStructure: Uint8Array;
  address: ReturnType<typeof parseCardanoAddress>;
}

function map(value: Cbor | undefined): Map<number | string, Cbor> {
  if (!(value instanceof Map)) throw new Error('Expected COSE map'); return value;
}
function bytes(value: Cbor | undefined, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`Expected ${label} bytes`); return value;
}
function onlyKeys(value: Map<number | string, Cbor>, allowed: (number | string)[]): void {
  for (const k of value.keys()) if (!allowed.includes(k)) throw new Error('Unsupported COSE header');
}

export function cip8SignStructure(protectedHeaders: Uint8Array, payload: Uint8Array): Uint8Array {
  return encodeCbor(['Signature1', protectedHeaders, new Uint8Array(), payload]);
}

export function verifyCip8Signature(
  signed: DataSignature,
  expected: { address: string; network: CardanoNetwork; payload: Uint8Array },
): VerifiedCip8 {
  if (signed.signature.length > 32768 || signed.key.length > 2048) throw new Error('COSE size limit');
  const sign1 = decodeCbor(fromHex(signed.signature), true);
  if (!Array.isArray(sign1) || sign1.length !== 4) throw new Error('Expected COSE_Sign1');
  const protectedHeaders = bytes(sign1[0], 'protected header');
  if (protectedHeaders.length > 256) throw new Error('Protected header size limit');
  const headers = map(decodeCbor(protectedHeaders));
  onlyKeys(headers, [1, 4, 'address']);
  const unprotected = map(sign1[1]); onlyKeys(unprotected, ['hashed']);
  if (headers.get(1) !== -8 || (unprotected.has('hashed') && unprotected.get('hashed') !== false)) {
    throw new Error('Unsupported COSE algorithm or hashed payload');
  }
  const address = parseCardanoAddress(expected.address, expected.network);
  if (!equalBytes(bytes(headers.get('address'), 'address'), address.bytes)) throw new Error('Signed address mismatch');
  if (!equalBytes(bytes(sign1[2], 'payload'), expected.payload)) throw new Error('Signed payload mismatch');
  const signature = bytes(sign1[3], 'signature');
  if (signature.length !== 64) throw new Error('Invalid Ed25519 signature length');
  const key = map(decodeCbor(fromHex(signed.key))); onlyKeys(key, [1, 2, 3, -1, -2]);
  if (key.get(1) !== 1 || key.get(3) !== -8 || key.get(-1) !== 6) throw new Error('Unsupported COSE key');
  if (headers.has(4) !== key.has(2) || (headers.has(4) && !equalBytes(bytes(headers.get(4), 'kid'), bytes(key.get(2), 'kid')))) {
    throw new Error('COSE key identifier mismatch');
  }
  const publicKey = bytes(key.get(-2), 'public key');
  assertAddressKey(address, publicKey);
  const point = ed25519.Point.fromBytes(publicKey, false);
  if (point.isSmallOrder() || !point.isTorsionFree()) throw new Error('Unsupported Ed25519 key subgroup');
  const signStructure = cip8SignStructure(protectedHeaders, expected.payload);
  if (!ed25519.verify(signature, signStructure, publicKey, { zip215: false })) throw new Error('Invalid Cardano signature');
  return { publicKey, protectedHeaders, signature, signStructure, address };
}
