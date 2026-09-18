import { concatBytes } from './bytes.js';

// Deliberately bounded subset for CIP-30. No indefinite lengths, floats, complex
// map keys, duplicate keys, non-minimal lengths, nested tags, or trailing data.
export type Cbor = number | boolean | null | string | Uint8Array | Cbor[] | Map<number | string, Cbor>;

export function decodeCbor(bytes: Uint8Array, allowSign1Tag = false): Cbor {
  if (bytes.length > 16_384) throw new Error('CBOR size limit');
  let cursor = 0;
  function take(n: number): Uint8Array {
    if (cursor + n > bytes.length) throw new Error('Truncated CBOR');
    const out = bytes.slice(cursor, cursor + n); cursor += n; return out;
  }
  function read(depth: number): Cbor {
    if (depth > 8) throw new Error('CBOR depth limit');
    const first = take(1)[0]!;
    const major = first >> 5; const ai = first & 31;
    if (major === 7) {
      if (ai === 20) return false;
      if (ai === 21) return true;
      if (ai === 22) return null;
      throw new Error('Unsupported CBOR simple value');
    }
    let length: number;
    if (ai < 24) length = ai;
    else {
      if (ai > 26) throw new Error('Unsupported CBOR length');
      const width = 2 ** (ai - 24);
      length = take(width).reduce((v, b) => v * 256 + b, 0);
      if (length < (width === 1 ? 24 : 2 ** (8 * (width / 2)))) throw new Error('Non-minimal CBOR');
    }
    if (major === 0) return length;
    if (major === 1) return -1 - length;
    if (major === 2) return take(length);
    if (major === 3) return new TextDecoder('utf-8', { fatal: true }).decode(take(length));
    if (major === 4) {
      if (length > 64) throw new Error('CBOR array limit');
      return Array.from({ length }, () => read(depth + 1));
    }
    if (major === 5) {
      if (length > 16) throw new Error('CBOR map limit');
      const map = new Map<number | string, Cbor>();
      for (let i = 0; i < length; i++) {
        const key = read(depth + 1);
        if (typeof key !== 'number' && typeof key !== 'string') throw new Error('Unsupported CBOR map key');
        if (map.has(key)) throw new Error('Duplicate CBOR key');
        map.set(key, read(depth + 1));
      }
      return map;
    }
    if (major === 6 && allowSign1Tag && depth === 0 && length === 18) return read(depth + 1);
    throw new Error('Unsupported CBOR encoding');
  }
  const result = read(0);
  if (cursor !== bytes.length) throw new Error('Trailing CBOR bytes');
  return result;
}

function head(major: number, n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) throw new Error('CBOR integer range');
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 256) return Uint8Array.of((major << 5) | 24, n);
  if (n < 65536) return Uint8Array.of((major << 5) | 25, n >> 8, n & 255);
  return Uint8Array.of((major << 5) | 26, n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}

export function encodeCbor(value: Cbor): Uint8Array {
  if (value === null) return Uint8Array.of(0xf6);
  if (typeof value === 'boolean') return Uint8Array.of(value ? 0xf5 : 0xf4);
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const data = new TextEncoder().encode(value); return concatBytes(head(3, data.length), data);
  }
  if (value instanceof Uint8Array) return concatBytes(head(2, value.length), value);
  if (Array.isArray(value)) return concatBytes(head(4, value.length), ...value.map(encodeCbor));
  return concatBytes(head(5, value.size), ...Array.from(value, ([k, v]) => concatBytes(encodeCbor(k), encodeCbor(v))));
}
