export function fromHex(hex: string): Uint8Array {
  if (typeof hex !== 'string') throw new Error('Expected hexadecimal string');
  const raw = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (raw.length % 2 || !/^[0-9a-f]*$/i.test(raw)) throw new Error('Invalid hexadecimal encoding');
  return Uint8Array.from(raw.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { result.set(p, offset); offset += p.length; }
  return result;
}
