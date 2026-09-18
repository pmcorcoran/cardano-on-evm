import { readProfileManifest } from './lib/identity-manifest.js';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { parseArgs, parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { createPublicClient, http, keccak256, toHex, getAddress, type Address } from 'viem';
import { baseSepolia } from 'viem/chains';
import { entryPoint07Abi } from 'viem/account-abstraction';
import { createProfileEnrollmentService, createEnrollmentHandler, MemoryChallengeStore } from '../packages/enrollment/src/index.js';
import { accountFromVerifiedKey, accountFactory, accountPreparation, operationFromJson, operationHash, operationPayload, operationToJson, decodeCalls, decodeRestrictedCalls, validatorSignature, type CardanoAccount, type ProfileIdentityConfig } from '../packages/sdk/src/index.js';
import { verifyCip8Signature, fromHex } from '../packages/wallet/src/index.js';
import { createPublicBundlerAdapter, createPrivateBundlerAdapter, createDirectAdapter, httpRpc, inclusionFromReceipt, type OperationContext, type Submission, type SubmissionAdapter } from '../packages/submission/src/index.js';
import { liveContext, entryPoint, json } from './lib/live-context.js';
import { canonicalReceipt } from './lib/canonical-receipt.js';
import { walletMetadata } from './lib/wallet-metadata.js';

const { values } = parseArgs({ options: { port: { type: 'string', default: '4174' }, manifest: { type: 'string' }, 'evidence-dir': { type: 'string', default: '.local/reference-evidence' }, 'infrastructure-manifest': { type: 'string' }, journal: { type: 'string' }, 'key-file': { type: 'string' }, 'key-variable': { type: 'string', default: 'SUBMITTER_PRIVATE_KEY' }, 'private-secrets-file': { type: 'string', default: '.local/private-bundler/base-sepolia.env' } } });
if (!values.manifest) throw new Error('--manifest is required');
if (values['key-file'] && (!values['infrastructure-manifest'] || !values.journal)) throw new Error('Direct submission requires --infrastructure-manifest and --journal');
const port = Number(values.port); if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid reference application port');
const origin = `http://127.0.0.1:${port}`;
const manifest = readProfileManifest(values.manifest!);
if (manifest.chainId !== 84532) throw new Error('This reference deployment targets Base Sepolia');
const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org';
const testFixture = manifest.testData === true && manifest.kind === 'generated-loopback-profile-manifest';
if (testFixture && (!['127.0.0.1', '[::1]', 'localhost'].includes(new URL(rpcUrl).hostname) || values['key-file'])) throw new Error('Generated fixtures require loopback RPC without a transaction submitter');
const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
if (await client.getChainId() !== 84532) throw new Error('RPC chain mismatch');
if (manifest.infrastructureVerified !== true && !testFixture) throw new Error('Deploy and verify the planned infrastructure before running the reference app');
const profiles = Object.fromEntries(Object.entries(manifest.profiles).map(([name, value]: [string, any]) => {
  const config = value.config;
  if (config.entryPoint.toLowerCase() !== entryPoint.toLowerCase() || config.chainId !== 84532) throw new Error('Profile network differs from the reference network');
  return [name, { ...value, config: { ...config, index: BigInt(config.index) } as ProfileIdentityConfig }];
}));
const services = Object.fromEntries(Object.entries(profiles).map(([name, p]) => {
  const store = new MemoryChallengeStore();
  return [name, { store, handler: createEnrollmentHandler(createProfileEnrollmentService({ application: origin, cardanoNetwork: 0, config: p.config, store })) }];
}));
const bundle = await build({ entryPoints: ['apps/reference/main.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
const sessions = new Map<string, { account: CardanoAccount; profile: string; enrollmentFile: string; expiresAt: number; wallet: ReturnType<typeof walletMetadata> }>();
const operations = new Map<string, { context: OperationContext; submission?: Submission; mode: Submission['mode']; sessionId: string; file: string; status: string; directJournal?: string }>();
const privateEnv = !testFixture && existsSync(values['private-secrets-file']!) ? parseEnv(readFileSync(values['private-secrets-file']!, 'utf8')) : {};
const availableModes = ['public', ...(privateEnv.BUNDLER_AUTH_TOKEN ? ['private'] : []), ...(values['key-file'] ? ['direct'] : [])];
const networkRpc = httpRpc(process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org');
const publicAdapter = createPublicBundlerAdapter(httpRpc(process.env.PUBLIC_BUNDLER_RPC_URL ?? 'https://public.pimlico.io/v2/84532/rpc', { minimumIntervalMs: 3500 }));
const privateAdapter = privateEnv.BUNDLER_AUTH_TOKEN ? createPrivateBundlerAdapter(httpRpc('http://127.0.0.1:4337/rpc', { headers: { authorization: `Bearer ${privateEnv.BUNDLER_AUTH_TOKEN}` }, timeoutMs: 55000 })) : undefined;
let active = 0, allowance = 120, updatedAt = Date.now();
const publicError = (error: unknown) => error instanceof Error ? error.message.replace(/https?:\/\/\S+/gi, '[RPC endpoint]').replace(/0x[0-9a-fA-F]{64,}/g, '[encoded data]').slice(0, 400) : 'Request failed';
async function state(account: CardanoAccount) {
  const address = account.identity.account;
  const [code, prepared, nonce, balance, deposit] = await Promise.all([
    client.getCode({ address }), client.getCode({ address: accountFactory(account) }),
    client.readContract({ address: entryPoint, abi: entryPoint07Abi, functionName: 'getNonce', args: [address, 0n] }),
    client.getBalance({ address }), client.readContract({ address: entryPoint, abi: entryPoint07Abi, functionName: 'balanceOf', args: [address] }),
  ]);
  return { address, deployed: Boolean(code && code !== '0x'), prepared: Boolean(prepared && prepared !== '0x'), nonce, balance, deposit, preparation: accountPreparation(account) };
}
const server = createServer(async (req, res) => {
  const send = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(json(data)); };
  if (req.headers.host !== `127.0.0.1:${port}`) return send(403, { error: 'Unexpected host' });
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" }); res.end(readFileSync('apps/reference/index.html')); return;
  }
  if (req.method === 'GET' && req.url === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(bundle.outputFiles[0]!.contents); return; }
  if (req.method === 'GET' && req.url === '/config') return send(200, { application: origin, chainId: 84532, cardanoNetwork: 0, availableModes, profiles: Object.fromEntries(Object.entries(profiles).map(([name, p]) => [name, { config: p.config, counter: p.counter, recipient: p.permittedRecipient }])) });
  if (req.method !== 'POST' || req.headers.origin !== origin || !req.headers['content-type']?.startsWith('application/json')) return send(403, { error: 'Use the local reference application' });
  const now = Date.now(); allowance = Math.min(120, allowance + (now - updatedAt) / 500); updatedAt = now;
  if (allowance < 1 || active >= 4) { req.resume(); return send(429, { error: 'Request limit; retry shortly' }); }
  allowance--; active++;
  try {
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 65536) throw new Error('Request too large'); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected request object');
    const enrollment = req.url?.match(/^\/enrollment\/(general|targets|selectors)\/(challenge|enroll)$/);
    if (enrollment) {
      const name = enrollment[1]!, action = enrollment[2]!, service = services[name]!;
      const metadata = walletMetadata(body);
      if (action === 'enroll' && body.walletId !== undefined && (typeof body.walletVersion !== 'string' || !body.walletVersion.trim() || body.walletVersion.length > 80 || typeof body.userAgent !== 'string' || body.userAgent.length > 512)) throw new Error('Wallet release and browser metadata required');
      service.store.prune(Date.now());
      const challenge = action === 'enroll' && typeof body.id === 'string' ? await service.store.get(body.id) : undefined;
      const enrollmentBody = action === 'challenge' ? { address: body.address } : { id: body.id, signature: body.signature, key: body.key };
      const response = await service.handler(new Request(`${origin}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(enrollmentBody) }));
      const data = await response.json();
      if (response.ok && challenge) {
        for (const [id, session] of sessions) if (Date.now() >= session.expiresAt) sessions.delete(id);
        if (sessions.size >= 100) throw new Error('Reference session limit');
        const signed = { signature: body.signature, key: body.key };
        const verified = verifyCip8Signature(signed, { address: challenge.cardanoAddress, network: 0, payload: fromHex(challenge.payloadHex) });
        const account = accountFromVerifiedKey(verified, profiles[name]!.config);
        const sessionId = randomBytes(32).toString('hex');
        const file = `${values['evidence-dir']}/enrollment-${challenge.id}.json`; mkdirSync(values['evidence-dir']!, { recursive: true });
        writeFileSync(file, json({ kind: 'reference-application-enrollment', testData: testFixture, profile: name, challenge, signed, verified: data, sdkAccount: account, configBound: true, source: testFixture ? 'Generated loopback test wallet; no deployed infrastructure or public-chain acceptance' : 'CIP-30 browser; cryptographically verified and atomically consumed; wallet metadata is reported provenance, not brand authentication', wallet: { ...metadata, release: String(body.walletVersion ?? '').trim().slice(0, 80), userAgent: String(body.userAgent ?? '').slice(0, 512) } }), { flag: 'wx' });
        sessions.set(sessionId, { account, profile: name, enrollmentFile: file, expiresAt: Date.now() + 2 * 60 * 60 * 1000, wallet: metadata });
        data.sessionId = sessionId; data.enrollmentFile = file;
      }
      return send(response.status, data);
    }
    const session = sessions.get(body.sessionId);
    if (!session || Date.now() >= session.expiresAt) throw new Error('Enrollment session expired; enroll again');
    if (req.url === '/state') return send(200, await state(session.account));
    if (req.url === '/submit') {
      const metadata = walletMetadata(body);
      if (session.wallet.id !== undefined && metadata.id !== session.wallet.id) throw new Error('Selected wallet differs from enrollment; enroll again');
      if (testFixture) throw new Error('Generated loopback fixtures cannot submit transactions');
      if (!availableModes.includes(body.mode)) throw new Error('Submission mode unavailable');
      const account = session.account, operation = operationFromJson(body.operation);
      if (getAddress(operation.sender) !== getAddress(account.identity.account) || operation.paymaster) throw new Error('Operation identity or sponsor differs');
      if (operation.factory && (getAddress(operation.factory) !== getAddress(accountFactory(account)) || operation.factoryData !== account.identity.factoryData)) throw new Error('Deployment configuration differs');
      if (operation.verificationGasLimit > 500000n || operation.callGasLimit > 250000n || operation.preVerificationGas > 100000n || (operation.verificationGasLimit + operation.callGasLimit + operation.preVerificationGas) * operation.maxFeePerGas > 42500000000000n) throw new Error('Reference operation gas cap exceeded');
      const calls = account.profile === 'restricted' ? decodeRestrictedCalls(operation.callData) : decodeCalls(operation.callData);
      if (calls.reduce((sum, call) => sum + call.value, 0n) > 100000000000n) throw new Error('Reference transfer cap exceeded');
      const payload = operationPayload(operation, 84532, entryPoint);
      const verified = verifyCip8Signature(body.authorization, { address: account.cardanoAddress, network: account.cardanoNetwork, payload: fromHex(payload) });
      if (toHex(verified.publicKey) !== account.publicKey || keccak256(verified.protectedHeaders) !== account.protectedHeaderHash || validatorSignature(verified) !== operation.signature) throw new Error('Operation signature differs from enrollment');
      const hash = operationHash(operation, 84532, entryPoint);
      const known = operations.get(hash);
      if (known) {
        if (known.sessionId !== body.sessionId) throw new Error('This authorization is already tracked by another enrollment session');
        return send(200, { hash, mode: known.mode, status: known.status, submission: known.submission });
      }
      if (operations.size >= 1000) throw new Error('Reference operation limit reached; preserve the evidence and restart this demonstration');
      const current = await state(account);
      if (!current.prepared) throw new Error('An operator must submit the permissionless preparation intent before this account can deploy');
      if (current.nonce !== operation.nonce) throw new Error('Account nonce changed; construct and review a new operation');
      const context: OperationContext = { chainId: 84532, entryPoint, operation };
      const file = `${values['evidence-dir']}/operation-${hash.slice(2)}.json`;
      const record = { context, mode: body.mode as Submission['mode'], sessionId: body.sessionId, file, status: 'broadcast-result-unknown' } as NonNullable<ReturnType<typeof operations.get>>;
      const persist = () => writeFileSync(file, json({ kind: 'reference-application-operation', enrollmentFile: session.enrollmentFile, profile: session.profile, wallet: { ...metadata, release: String(body.walletVersion ?? '').trim().slice(0, 80), userAgent: String(body.userAgent ?? '').slice(0, 512) }, context, authorization: body.authorization, mode: record.mode, submission: record.submission, status: record.status, directJournal: record.directJournal }));
      if (existsSync(file)) throw new Error('This authorization already has saved evidence; inspect its hash and receipt before retrying after a server restart');
      operations.set(hash, record); persist();
      let live: Awaited<ReturnType<typeof liveContext>> | undefined;
      try {
        let adapter: SubmissionAdapter;
        if (body.mode === 'public') adapter = publicAdapter;
        else if (body.mode === 'private') adapter = privateAdapter!;
        else {
          live = await liveContext(values['key-file']!, values['key-variable']!, { manifest: values['infrastructure-manifest']!, journal: values.journal!, independentSubmitter: true });
          record.directJournal = live.journalFile; persist();
          const context = live;
          adapter = createDirectAdapter({ rpc: networkRpc, submitter: context.account.address, sendTransaction: async (intent) => (await context.transact(`reference-${hash}`, intent, true))!.transactionHash });
        }
        record.submission = await adapter.submit(context); record.status = 'submitted'; persist();
      } catch (error) { persist(); throw error; } finally { live?.release(); }
      return send(200, { hash, mode: record.mode, status: record.status, submission: record.submission });
    }
    if (req.url === '/status') {
      const record = operations.get(body.hash);
      if (!record || record.sessionId !== body.sessionId) throw new Error('Unknown operation in this session');
      let submission = record.submission;
      if (!submission && record.mode === 'direct' && record.directJournal && existsSync(record.directJournal)) {
        const journal = JSON.parse(readFileSync(record.directJournal, 'utf8'));
        const tx = journal.transactions[`reference-${body.hash}`];
        if (tx) submission = { mode: 'direct', userOperationHash: body.hash, transactionHash: tx.transactionHash };
      }
      submission ??= { mode: record.mode, userOperationHash: body.hash };
      let included;
      if (record.mode === 'direct') included = submission.transactionHash ? inclusionFromReceipt(record.context, await canonicalReceipt(client, submission.transactionHash)) : { status: 'pending', userOperationHash: body.hash };
      else included = await (record.mode === 'public' ? publicAdapter : privateAdapter!).status(record.context, submission);
      if (included.transactionHash) {
        included = inclusionFromReceipt(record.context, await canonicalReceipt(client, included.transactionHash));
        record.status = included.status;
        const evidence = JSON.parse(readFileSync(record.file, 'utf8')); evidence.inclusion = included; evidence.status = included.status; evidence.independentlyObservedThroughBaseRpc = true; writeFileSync(record.file, json(evidence));
      }
      return send(200, included);
    }
    send(404, { error: 'Unknown reference route' });
  } catch (error) { send(400, { error: publicError(error) }); }
  finally { active--; }
});
server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 32;
server.listen(port, '127.0.0.1', () => console.log(`Reference application: ${origin}`));
