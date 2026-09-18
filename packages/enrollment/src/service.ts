import { randomBytes } from 'node:crypto';
import { fromHex, toHex, parseCardanoAddress, verifyCip8Signature, type VerifiedCip8, type DataSignature, type CardanoNetwork } from '@cardano-on-evm/wallet';
import type { ChallengeRecord, ChallengeStore } from './store.js';

export const ENROLLMENT_DOMAIN = 'cardano-kernel:enrollment:v1';
export interface EnrollmentScope {
  application: string;
  baseChainId: number;
  cardanoNetwork: CardanoNetwork;
  configHash: string;
}
export type EnrollmentOptions<T> = EnrollmentScope & {
  store: ChallengeStore;
  deriveIdentity: (verified: VerifiedCip8) => T | Promise<T>;
  ttlMs?: number;
  now?: () => number;
};

function payload(record: Omit<ChallengeRecord, 'payloadHex'>): Uint8Array {
  // Explicit property order, UTF-8, decimal safe integers, lowercase raw address.
  return new TextEncoder().encode(JSON.stringify({
    domain: ENROLLMENT_DOMAIN, challenge: record.id, application: record.application,
    cardanoAddress: record.cardanoAddress, cardanoNetwork: record.cardanoNetwork,
    baseChainId: record.baseChainId, configHash: record.configHash,
    issuedAt: record.issuedAt, expiresAt: record.expiresAt,
  }));
}

export function createEnrollmentService<T>(options: EnrollmentOptions<T>) {
  const application = new URL(options.application);
  if (!['https:', 'http:'].includes(application.protocol) || application.origin !== options.application) throw new Error('Application must be an exact HTTP(S) origin');
  if (!Number.isSafeInteger(options.baseChainId) || options.baseChainId <= 0) throw new Error('Invalid Base chain ID');
  if (options.cardanoNetwork !== 0 && options.cardanoNetwork !== 1) throw new Error('Invalid Cardano network');
  if (!/^0x[0-9a-f]{64}$/.test(options.configHash)) throw new Error('Configuration hash must be canonical bytes32');
  const scope: EnrollmentScope = Object.freeze({ application: options.application, baseChainId: options.baseChainId, cardanoNetwork: options.cardanoNetwork, configHash: options.configHash });
  const ttlMs = options.ttlMs ?? 300_000; const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 900_000) throw new Error('Challenge lifetime must be 1..900000 ms');
  return {
    async issue(cardanoAddress: string): Promise<ChallengeRecord> {
      const address = parseCardanoAddress(cardanoAddress, scope.cardanoNetwork);
      const issuedAt = now();
      const data = { ...scope, id: randomBytes(32).toString('hex'), cardanoAddress: address.hex, issuedAt, expiresAt: issuedAt + ttlMs };
      const record = { ...data, payloadHex: toHex(payload(data)) };
      await options.store.put(record); return record;
    },
    async enroll(id: string, signed: DataSignature): Promise<{ identity: T; publicKey: string; address: string; credential: 'payment' | 'stake' }> {
      if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('Invalid challenge identifier');
      const challenge = await options.store.get(id);
      if (!challenge || now() >= challenge.expiresAt || now() < challenge.issuedAt) throw new Error('Challenge expired or unavailable');
      if (challenge.application !== scope.application || challenge.baseChainId !== scope.baseChainId || challenge.cardanoNetwork !== scope.cardanoNetwork || challenge.configHash !== scope.configHash) throw new Error('Challenge scope mismatch');
      if (challenge.payloadHex !== toHex(payload(challenge))) throw new Error('Challenge storage integrity failure');
      const verified = verifyCip8Signature(signed, { address: challenge.cardanoAddress, network: scope.cardanoNetwork, payload: fromHex(challenge.payloadHex) });
      const identity = await options.deriveIdentity(verified);
      // Expiry is checked again after verification/derivation, atomically with use.
      if (!(await options.store.consume(id, challenge.payloadHex, now()))) throw new Error('Challenge expired or already consumed');
      return { identity, publicKey: toHex(verified.publicKey), address: verified.address.hex, credential: verified.address.credential };
    },
  };
}

/** Framework-neutral Fetch handler. Configure scope server-side, never trust an
 * application/chain/config claim in the request to define the server's scope.
 * Hosts provide TLS, request limits, rate limiting, and a persistent store. */
export function createEnrollmentHandler<T>(service: ReturnType<typeof createEnrollmentService<T>>) {
  return async (request: Request): Promise<Response> => {
    try {
      const route = new URL(request.url).pathname;
      if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });
      if (!request.headers.get('content-type')?.startsWith('application/json')) return Response.json({ error: 'Expected JSON' }, { status: 415 });
      // Count while reading; do not buffer an unbounded body before checking size.
      const reader = request.body?.getReader();
      if (!reader) throw new Error('Missing request body');
      let length = 0; const chunks: Uint8Array[] = [];
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.length;
        if (length > 40_000) { await reader.cancel(); throw new Error('Request too large'); }
        chunks.push(value);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid request');
      if (route === '/challenge' && typeof body.address === 'string' && Object.keys(body).length === 1) return Response.json(await service.issue(body.address));
      if (route === '/enroll' && typeof body.id === 'string' && typeof body.signature === 'string' && typeof body.key === 'string' && Object.keys(body).length === 3) return Response.json(await service.enroll(body.id, { signature: body.signature, key: body.key }));
      throw new Error('Unknown route or invalid request');
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Enrollment failed' }, { status: 400 });
    }
  };
}
