import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import { keccak256, encodeAbiParameters, stringToHex } from 'viem';
import { createEnrollmentService, MemoryChallengeStore } from '../packages/enrollment/src/index.js';
import { verifyCip8Signature, fromHex, toHex, parseCardanoAddress } from '../packages/wallet/src/index.js';
import { liveEvidence } from './lib/live-evidence.js';
import { walletMetadata } from './lib/wallet-metadata.js';

const port = Number(process.env.WALLET_LAB_PORT ?? 4173);
const origin = `http://127.0.0.1:${port}`;
const stores = [new MemoryChallengeStore(), new MemoryChallengeStore()] as const;
const services = stores.map((store, network) => createEnrollmentService({
  store, application: origin, cardanoNetwork: network as 0 | 1, baseChainId: 84532,
  configHash: keccak256(stringToHex('cardano-kernel:wallet-lab:v1:format-probe-only')),
  deriveIdentity: (verified) => ({ publicKey: toHex(verified.publicKey), protectedHeaders: toHex(verified.protectedHeaders) }),
}));
const bundle = await build({ entryPoints: ['apps/wallet-lab/main.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
const liveBundle = await build({ entryPoints: ['apps/live-lab/main.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
const live = liveEvidence(process.env.LIVE_EVIDENCE_DIR ?? '.local/operation-evidence');
const captureDirectory = process.env.WALLET_CAPTURE_DIR ?? '.local/wallet-captures';

function operationProbe(id: string) {
  const context = {
    chainId: 84532,
    entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as const,
    account: '0x000000000000000000000000000000000000dEaD' as const,
    sessionNonce: `0x${id}` as `0x${string}`,
  };
  const probeHash = keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }], ['cardano-kernel:unsubmitted-format-probe:v1', 84532n, context.entryPoint, context.account, context.sessionNonce]));
  const payloadHex = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [keccak256(stringToHex('cardano-kernel:operation:v1')), probeHash])).slice(2);
  return { ...context, probeHash, payloadHex, submitted: false };
}

const server = createServer(async (req, res) => {
  const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  try {
    // Loopback-only lab. Reject cross-origin writes and DNS rebinding hosts.
    if (req.headers.host !== `127.0.0.1:${port}`) { send(403, { error: 'Unexpected host' }); return; }
    if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; script-src 'self'; frame-ancestors 'none'" }); res.end(readFileSync('apps/wallet-lab/index.html')); return; }
    if (req.method === 'GET' && req.url === '/wallet.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundle.outputFiles[0]!.contents); return; }
    if (req.method === 'GET' && (req.url === '/live' || req.url === '/live/')) { res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; script-src 'self'; frame-ancestors 'none'" }); res.end(readFileSync('apps/live-lab/index.html')); return; }
    if (req.method === 'GET' && req.url === '/live.js') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(liveBundle.outputFiles[0]!.contents); return; }
    if (req.method === 'GET' && req.url === '/live/requests') { send(200, { requests: live.list() }); return; }
    if (req.method !== 'POST' || req.headers.origin !== origin || !req.headers['content-type']?.startsWith('application/json')) { send(403, { error: 'Use the local wallet laboratory page' }); return; }
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 40_000) throw new Error('Request too large'); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === '/live/signature') { send(200, live.capture(body)); return; }
    if (body.network !== 0 && body.network !== 1) throw new Error('Choose a supported Cardano network');
    const service = services[body.network]!; const store = stores[body.network as 0 | 1];
    store.prune(Date.now());
    if (req.url === '/lab/challenge') {
      if (body.credential && parseCardanoAddress(body.address, body.network).credential !== body.credential) throw new Error('Selected credential does not match the address');
      const challenge = await service.issue(body.address); send(200, { ...challenge, operation: operationProbe(challenge.id) }); return;
    }
    if (req.url === '/lab/capture') {
      if (typeof body.walletRelease !== 'string' || !body.walletRelease.trim() || body.walletRelease.length > 80 || typeof body.userAgent !== 'string' || body.userAgent.length > 512) throw new Error('Wallet release and browser metadata are required');
      const metadata = walletMetadata(body);
      const challenge = await store.get(body.id); if (!challenge) throw new Error('Challenge unavailable');
      if (body.credential && parseCardanoAddress(challenge.cardanoAddress, challenge.cardanoNetwork).credential !== body.credential) throw new Error('Selected credential does not match the challenge');
      const operation = operationProbe(challenge.id);
      const verified = verifyCip8Signature(body.operation, { address: challenge.cardanoAddress, network: challenge.cardanoNetwork, payload: fromHex(operation.payloadHex) });
      const enrollmentSignature = verifyCip8Signature(body.enrollment, { address: challenge.cardanoAddress, network: challenge.cardanoNetwork, payload: fromHex(challenge.payloadHex) });
      if (toHex(enrollmentSignature.publicKey) !== toHex(verified.publicKey)) throw new Error('Wallet key changed between signatures');
      if (toHex(enrollmentSignature.protectedHeaders) !== toHex(verified.protectedHeaders)) throw new Error('Wallet protected-header profiles differ between signatures');
      const enrollment = await service.enroll(body.id, body.enrollment);
      if (enrollment.publicKey !== toHex(verified.publicKey)) throw new Error('Wallet key changed between signatures');
      const evidence = {
        kind: 'operator-wallet-capture', capturedAt: new Date().toISOString(),
        provenance: 'CIP-30 browser capture; wallet brand and release supplied by the operator; signatures cryptographically verified by server',
        wallet: { ...metadata, release: body.walletRelease.trim(), userAgent: body.userAgent },
        enrollment: { challenge, signed: body.enrollment, verified: enrollment },
        operation: { ...operation, signed: body.operation, protectedHeaders: toHex(verified.protectedHeaders) },
        onchainValidated: false, liveAccountExecuted: false,
      };
      const file = `${captureDirectory}/${challenge.id}.json`;
      mkdirSync(captureDirectory, { recursive: true }); writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
      send(200, { file, ...evidence }); return;
    }
    send(404, { error: 'Unknown laboratory endpoint' });
  } catch (error) { send(400, { error: error instanceof Error ? error.message : 'Capture failed' }); }
});
server.listen(port, '127.0.0.1', () => console.log(`Wallet laboratory: ${origin}`));
