import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { concatBytes, encodeCbor, toHex, cip8SignStructure, type Cbor, type DataSignature } from '../packages/wallet/src/index.js';

// Public deterministic TEST seed only. Never imported by runtime packages.
// These fixtures are generated, not observed Lace signatures.
export const fixtureSeed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
export const fixturePublicKey = ed25519.getPublicKey(fixtureSeed);
export function fixtureAddress(type: 0 | 2 | 6 | 14 = 6, network: 0 | 1 = 0, key = fixturePublicKey): Uint8Array {
  return concatBytes(Uint8Array.of((type << 4) | network), blake2b(key, { dkLen: 28 }), ...(type < 6 ? [new Uint8Array(28).fill(7)] : []));
}
export function signFixture(payload: Uint8Array, address = fixtureAddress(), seed = fixtureSeed, includeKid = false): DataSignature {
  const headers = encodeCbor(new Map<number | string, Cbor>([[1, -8], ...(includeKid ? [[4, address] as [number, Cbor]] : []), ['address', address]]));
  const signature = ed25519.sign(cip8SignStructure(headers, payload), seed);
  const sign1 = encodeCbor([headers, new Map([['hashed', false]]), payload, signature]);
  const key = encodeCbor(new Map<number | string, Cbor>([[1, 1], ...(includeKid ? [[2, address] as [number, Cbor]] : []), [3, -8], [-1, 6], [-2, ed25519.getPublicKey(seed)]]));
  return { signature: toHex(sign1), key: toHex(key) };
}
