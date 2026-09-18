import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { keccak256, toHex } from 'viem';
import { fromHex, verifyCip8Signature } from '../../packages/wallet/src/index.js';
import { operationToJson, validatorSignature } from '../../packages/protocol/src/index.js';
import { checkLiveRequest, type LiveRequest } from './live-request.js';
import { walletMetadata } from './wallet-metadata.js';

export function liveEvidence(root: string) {
  const readRequest = (id: string) => {
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('Invalid signing request ID');
    const request = JSON.parse(readFileSync(join(root, 'requests', `${id}.json`), 'utf8')) as LiveRequest;
    if (request.id !== id) throw new Error('Signing request ID mismatch'); checkLiveRequest(request); return request;
  };
  return {
    list() {
      const dir = join(root, 'requests'); if (!existsSync(dir)) return [];
      return readdirSync(dir).filter((file) => /^[0-9a-f]{64}\.json$/.test(file)).map((file) => {
        const request = readRequest(file.slice(0, -5));
        const signatureFile = join(root, 'signatures', `${request.id}.json`); const resultFile = join(root, 'results', `${request.id}.json`);
        return { request, signed: existsSync(signatureFile), result: existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : null };
      }).sort((a, b) => b.request.createdAt.localeCompare(a.request.createdAt)).slice(0, 30);
    },
    capture(body: any) {
      if (!body || typeof body !== 'object') throw new Error('Invalid signature submission');
      const metadata = walletMetadata(body);
      const request = readRequest(body.id);
      if (request.walletId !== undefined && metadata.id !== request.walletId) throw new Error('Selected wallet differs from enrollment; enroll again');
      const operation = checkLiveRequest(request);
      if (typeof body.walletVersion !== 'string' || !body.walletVersion.trim() || body.walletVersion.length > 80 || typeof body.userAgent !== 'string' || body.userAgent.length > 512) throw new Error('Wallet release and browser metadata required');
      const verified = verifyCip8Signature(body.signed, { address: request.cardanoAddress, network: request.cardanoNetwork, payload: fromHex(request.payloadHex) });
      if (toHex(verified.publicKey).toLowerCase() !== request.publicKey.toLowerCase() || keccak256(verified.protectedHeaders) !== request.protectedHeaderHash) throw new Error('Wallet key or protected header profile changed');
      const signedOperation = { ...operation, signature: validatorSignature(verified) };
      const record = { kind: 'real-wallet-live-operation-authorization', capturedAt: new Date().toISOString(), requestId: request.id, request, wallet: { ...metadata, release: body.walletVersion.trim(), userAgent: body.userAgent }, provenance: 'Wallet identity and release are reported; cryptographic verification establishes key/address ownership, not wallet brand', signed: body.signed, operation: operationToJson(signedOperation), credentialAndContextVerified: true, submitted: false };
      mkdirSync(join(root, 'signatures'), { recursive: true }); const file = join(root, 'signatures', `${request.id}.json`);
      writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
      return { file, id: request.id, userOperationHash: request.userOperationHash, status: 'signature-verified-and-saved' };
    },
  };
}
