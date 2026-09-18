import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { encodeFunctionData, keccak256, parseEther, toHex, type Abi, type Address, type Hex } from 'viem';
import { entryPoint07Abi } from 'viem/account-abstraction';
import { deriveTableIdentity, encodeCalls, operationHash, operationPayload, operationToJson, packOperation, type Operation, type TableIdentityConfig } from '../../packages/protocol/src/index.js';
import { deriveBackendTableIdentity } from '../../packages/enrollment/src/identity.js';
import { liveContext, entryPoint, kernel, kernelFactory, json, matchesRuntime, assertLiveConfig } from '../lib/live-context.js';
import { checkLiveRequest, type LiveRequest } from '../lib/live-request.js';
import { readTableIdentityManifest } from '../lib/identity-manifest.js';
import { bindAddressArtifacts } from '../lib/address-artifacts.js';
import { readWalletCapture } from '../lib/wallet-capture.js';

let stage = 'read operation configuration';
let context: Awaited<ReturnType<typeof liveContext>> | undefined;
try {
  const { values } = parseArgs({ options: { infrastructure: { type: 'string' }, journal: { type: 'string' }, namespace: { type: 'string' }, out: { type: 'string' }, stake: { type: 'string' }, 'key-file': { type: 'string' }, 'key-variable': { type: 'string', default: 'SUBMITTER_PRIVATE_KEY' }, mode: { type: 'string', default: 'public' }, index: { type: 'string', default: '0' }, action: { type: 'string', default: 'increment' }, 'send-funding': { type: 'boolean', default: false } } });
  if (!values.infrastructure || !values.journal || !values.out || !/^0x[0-9a-fA-F]{64}$/.test(values.namespace ?? '') || !values.stake || !values['key-file'] || !['public', 'direct'].includes(values.mode!) || !['increment', 'batch'].includes(values.action!)) throw new Error('Invalid operation configuration');
  const stake = JSON.parse(readFileSync(values.stake, 'utf8'));
  if (!stake.runtimeAndAllImmutablesChecked || stake.chainId !== 84532) throw new Error('Verified Base Sepolia stake preparation required');
  const { capture, enrollment, challenge, sha256: captureSha256 } = readWalletCapture(stake.capture);
  if (stake.captureSha256 !== captureSha256 || challenge.baseChainId !== 84532 || stake.publicKey !== toHex(enrollment.publicKey) || stake.protectedHeaders !== toHex(enrollment.protectedHeaders) || enrollment.address.credential !== 'stake') throw new Error('Stake preparation differs from its verified wallet capture');
  stage = 'verify network and account prediction';
  context = await liveContext(values['key-file'], values['key-variable']!, { manifest: values.infrastructure, journal: values.journal, independentSubmitter: true });
  const { client, find, tableFactory, counter, transact } = context;
  const config: TableIdentityConfig = { chainId: 84532, entryPoint, kernelImplementation: kernel, kernelFactory, tableFactory, validatorCreationCode: `0x${find('PreparedTableValidator').evm.bytecode.object}`, namespace: values.namespace as Hex, index: BigInt(values.index!) };
  assertLiveConfig(config, context);
  if (stake.tableFactory.toLowerCase() !== tableFactory.toLowerCase() || stake.entryPoint.toLowerCase() !== entryPoint.toLowerCase()) throw new Error('Stake preparation infrastructure changed');
  const identity = deriveTableIdentity(stake.publicKey, stake.protectedHeaders, config);
  const backend = deriveBackendTableIdentity(stake.publicKey, stake.protectedHeaders, config);
  if (json(identity).toLowerCase() !== json(backend).toLowerCase() || identity.validator.toLowerCase() !== stake.validator.toLowerCase()) throw new Error('Independent identity predictions disagree');
  if (!matchesRuntime((await client.getCode({ address: identity.validator }))!, find('PreparedTableValidator'))) throw new Error('Prepared validator runtime changed');
  for (const [functionName, expected] of [['publicKey', identity.publicKey], ['protectedHeaderHash', keccak256(identity.protectedHeaders)], ['entryPoint', entryPoint], ['curveTable', stake.table]] as const) {
    const actual = await client.readContract({ address: identity.validator, abi: find('PreparedTableValidator').abi as Abi, functionName });
    if (String(actual).toLowerCase() !== expected.toLowerCase()) throw new Error('Prepared validator immutable changed');
  }
  const tableCode = await client.getCode({ address: stake.table });
  if (!tableCode || keccak256(tableCode) !== stake.tableRuntimeHash) throw new Error('Prepared curve table changed');
  const predicted = await client.readContract({ address: kernelFactory, abi: find('KernelFactory').abi as Abi, functionName: 'getAddress', args: [identity.initializeData, identity.accountSalt] }) as Address;
  if (predicted.toLowerCase() !== identity.account.toLowerCase()) throw new Error('Live factory prediction disagrees');
  const identityFile = `${values.out}/identity-${identity.account.toLowerCase()}.json`;
  mkdirSync(values.out, { recursive: true });
  let previousIdentity;
  try { previousIdentity = readTableIdentityManifest(identityFile); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || (error as NodeJS.ErrnoException).path !== identityFile) throw error; }
  previousIdentity ??= {};
  if (previousIdentity.identity && json(previousIdentity.identity).toLowerCase() !== json(identity).toLowerCase()) throw new Error('Saved account identity changed');
  if (!previousIdentity.identity) writeFileSync(identityFile, json({ kind: 'sdk-backend-live-factory-identity-agreement', timestamp: new Date().toISOString(), addressDerivationMode: 'portable', chainId: config.chainId, artifactBinding: bindAddressArtifacts(config), config, identity, backend, liveFactoryPrediction: predicted, agreement: true, sourceCapture: stake.capture, deployedAccountChecked: false }), { flag: 'wx' });
  const nonce = await client.readContract({ address: entryPoint, abi: entryPoint07Abi, functionName: 'getNonce', args: [identity.account, 0n] });
  const code = await client.getCode({ address: identity.account }); const first = !code || code === '0x';
  const requestKey = `${identity.account.toLowerCase()}-${nonce}-${values.mode}-${values.action}`;
  const pointer = `${values.out}/request-${requestKey}.json`;
  let previous;
  try { previous = JSON.parse(readFileSync(pointer, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (previous !== undefined) {
    const saved = JSON.parse(readFileSync(previous.file, 'utf8')), savedOperation = checkLiveRequest(saved);
    if (previous.identityFile !== identityFile || saved.id !== previous.id || saved.mode !== values.mode || savedOperation.nonce !== nonce || savedOperation.sender.toLowerCase() !== identity.account.toLowerCase() || saved.publicKey.toLowerCase() !== identity.publicKey.toLowerCase() || saved.protectedHeaderHash !== keccak256(identity.protectedHeaders)) throw new Error('Saved request differs from the selected account');
    console.log(json({ status: 'request-already-prepared', ...previous }));
  } else {
    stage = 'prefund account EntryPoint deposit';
    const deposit = await client.readContract({ address: entryPoint, abi: entryPoint07Abi, functionName: 'balanceOf', args: [identity.account] });
    if (deposit < parseEther('0.00007')) {
      const receipt = await transact(`prefund-${identity.account.toLowerCase()}-${nonce}`, { to: entryPoint, data: encodeFunctionData({ abi: entryPoint07Abi, functionName: 'depositTo', args: [identity.account] }), value: parseEther('0.0001') }, values['send-funding']);
      if (!receipt) throw new Error('Preview completed; execute the prepared test deposit before requesting a signature');
    }
    const increment = (amount: bigint) => encodeFunctionData({ abi: find('ExperimentCounter').abi as Abi, functionName: 'increment', args: [amount] });
    const calls = values.action === 'batch' ? [{ target: counter, value: 0n, data: increment(2n) }, { target: counter, value: 0n, data: increment(3n) }] : [{ target: counter, value: 0n, data: increment(1n) }];
    const operation: Operation = { sender: identity.account, nonce, ...(first ? { factory: kernelFactory, factoryData: identity.factoryData } : {}), callData: encodeCalls(calls), callGasLimit: 250_000n, verificationGasLimit: 500_000n, preVerificationGas: 100_000n, maxFeePerGas: 50_000_000n, maxPriorityFeePerGas: 2_000_000n, signature: '0x' };
    stage = 'compare actual EntryPoint operation hash';
    const hash = operationHash(operation, 84532, entryPoint);
    if (await client.readContract({ address: entryPoint, abi: entryPoint07Abi, functionName: 'getUserOpHash', args: [packOperation(operation)] }) !== hash) throw new Error('EntryPoint hash disagrees');
    const request: LiveRequest = { ...(capture.wallet?.id ? { walletId: capture.wallet.id } : {}), version: 1, id: randomBytes(32).toString('hex'), createdAt: new Date().toISOString(), title: `${first ? 'Deploy account and ' : ''}${values.action === 'batch' ? 'increment the test counter by 2 and 3' : 'increment the test counter by 1'}`, mode: values.mode as 'public' | 'direct', chainId: 84532, entryPoint, cardanoAddress: challenge.cardanoAddress, cardanoNetwork: challenge.cardanoNetwork, credential: 'stake', publicKey: stake.publicKey, protectedHeaderHash: keccak256(stake.protectedHeaders as Hex), userOperationHash: hash, payloadHex: operationPayload(operation, 84532, entryPoint), operation: operationToJson(operation), profile: 'experimental-general', validator: identity.validator, sourceCapture: stake.capture };
    checkLiveRequest(request);
    mkdirSync(`${values.out}/requests`, { recursive: true });
    const file = `${values.out}/requests/${request.id}.json`;
    writeFileSync(file, json(request), { flag: 'wx' });
    writeFileSync(pointer, json({ file, id: request.id, requestKey, identityFile }), { flag: 'wx' });
    console.log(json({ file, account: identity.account, validator: identity.validator, nonce, mode: values.mode, deployment: first, calls, maximumOperationGasCostWei: (operation.verificationGasLimit + operation.callGasLimit + operation.preVerificationGas) * operation.maxFeePerGas }));
  }
} catch {
  console.error(`Live operation preparation stopped during: ${stage}. Secrets and RPC configuration were withheld; existing transactions and requests remain in their journals.`); process.exitCode = 1;
} finally { context?.release(); }
