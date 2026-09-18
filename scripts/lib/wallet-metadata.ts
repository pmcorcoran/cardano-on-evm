import type { CardanoWalletId } from '../../packages/wallet/src/index.js';

/** Reported provenance only. Signature verification cannot authenticate a brand. */
export function walletMetadata(body: { walletId?: unknown; walletName?: unknown; walletApiVersion?: unknown }) {
  if (body.walletId !== undefined && body.walletId !== 'lace' && body.walletId !== 'eternl') throw new Error('Unsupported wallet ID');
  for (const field of ['walletName', 'walletApiVersion'] as const) {
    if (body[field] !== undefined && (typeof body[field] !== 'string' || !body[field].trim() || body[field].length > 80)) throw new Error(`Invalid ${field}`);
  }
  return {
    ...(body.walletId === undefined ? {} : { id: body.walletId as CardanoWalletId }),
    ...(body.walletName === undefined ? {} : { name: (body.walletName as string).trim() }),
    ...(body.walletApiVersion === undefined ? {} : { apiVersion: (body.walletApiVersion as string).trim() }),
  };
}
