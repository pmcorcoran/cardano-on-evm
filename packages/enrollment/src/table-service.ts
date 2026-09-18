import { toHex } from '@cardano-on-evm/wallet';
import type { CardanoNetwork } from '@cardano-on-evm/wallet';
import type { TableIdentityConfig } from '@cardano-on-evm/protocol';
import type { ProfileIdentityConfig } from '@cardano-on-evm/protocol';
import type { ChallengeStore } from './store.js';
import { createEnrollmentService } from './service.js';
import { backendTableConfigHash, deriveBackendTableIdentity, backendProfileConfigHash, deriveBackendProfileIdentity } from './identity.js';

/** Scope and derivation come from server configuration, never request claims. */
export function createTableEnrollmentService(options: {
  application: string; cardanoNetwork: CardanoNetwork; config: TableIdentityConfig;
  store: ChallengeStore; ttlMs?: number; now?: () => number;
}) {
  backendTableConfigHash(options.config);
  const config = Object.freeze({ ...options.config });
  return createEnrollmentService({
    application: options.application, cardanoNetwork: options.cardanoNetwork,
    baseChainId: config.chainId, configHash: backendTableConfigHash(config), store: options.store,
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}), ...(options.now ? { now: options.now } : {}),
    deriveIdentity: (verified) => deriveBackendTableIdentity(`0x${toHex(verified.publicKey)}`, `0x${toHex(verified.protectedHeaders)}`, config),
  });
}

export function createProfileEnrollmentService(options: {
  application: string; cardanoNetwork: CardanoNetwork; config: ProfileIdentityConfig;
  store: ChallengeStore; ttlMs?: number; now?: () => number;
}) {
  backendProfileConfigHash(options.config);
  const config = Object.freeze({ ...options.config });
  return createEnrollmentService({
    application: options.application, cardanoNetwork: options.cardanoNetwork,
    baseChainId: config.chainId, configHash: backendProfileConfigHash(config), store: options.store,
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}), ...(options.now ? { now: options.now } : {}),
    deriveIdentity: (verified) => deriveBackendProfileIdentity(`0x${toHex(verified.publicKey)}`, `0x${toHex(verified.protectedHeaders)}`, config),
  });
}
