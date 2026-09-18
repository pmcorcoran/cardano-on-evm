import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fromHex, toHex, verifyCip8Signature } from '../../packages/wallet/src/index.js';

import { walletMetadata } from './wallet-metadata.js';

/** Verify an explicitly supplied wallet-format capture without treating it as
 * enrollment authorization for a different account configuration. */
export function readWalletCapture(path: string) {
  assert.ok(path, 'An explicit wallet capture path is required');
  const bytes = readFileSync(path);
  const capture = JSON.parse(bytes.toString('utf8'));
  walletMetadata({ walletId: capture.wallet?.id });
  const challenge = capture.enrollment?.challenge;
  assert.ok(challenge && /^[0-9a-f]{64}$/.test(challenge.id), 'Invalid capture challenge');
  const application = new URL(challenge.application);
  assert.ok(['http:', 'https:'].includes(application.protocol) && application.origin === challenge.application, 'Invalid capture application');
  assert.ok(Number.isSafeInteger(challenge.baseChainId) && challenge.baseChainId > 0 && /^0x[0-9a-f]{64}$/.test(challenge.configHash), 'Invalid capture chain or configuration hash');
  assert.ok(Number.isSafeInteger(challenge.issuedAt) && Number.isSafeInteger(challenge.expiresAt) && challenge.expiresAt > challenge.issuedAt && challenge.expiresAt - challenge.issuedAt <= 900000, 'Invalid capture challenge lifetime');
  const payload = new TextEncoder().encode(JSON.stringify({ domain: 'cardano-kernel:enrollment:v1', challenge: challenge.id, application: challenge.application, cardanoAddress: challenge.cardanoAddress, cardanoNetwork: challenge.cardanoNetwork, baseChainId: challenge.baseChainId, configHash: challenge.configHash, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt }));
  assert.equal(toHex(fromHex(challenge.payloadHex)), toHex(payload), 'Capture challenge payload differs from its declared scope');
  const enrollment = verifyCip8Signature(capture.enrollment.signed, { address: challenge.cardanoAddress, network: challenge.cardanoNetwork, payload });
  const operation = capture.operation ? verifyCip8Signature(capture.operation.signed, { address: challenge.cardanoAddress, network: challenge.cardanoNetwork, payload: fromHex(capture.operation.payloadHex) }) : undefined;
  if (operation) {
    assert.equal(toHex(operation.publicKey), toHex(enrollment.publicKey), 'Capture signing keys differ');
    assert.equal(toHex(operation.protectedHeaders), toHex(enrollment.protectedHeaders), 'Capture protected-header profiles differ');
  }
  return { capture, challenge, enrollment, operation, sha256: createHash('sha256').update(bytes).digest('hex') };
}
