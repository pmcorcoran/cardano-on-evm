import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, keccak256, parseEther, type Abi, type Address, type Hex, type PublicClient, type WalletClient, type Transport, type TransactionReceipt } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { loadSubmitter } from './submitter.js';
import type { Artifact } from '../build-contracts.js';
import { canonicalReceipt } from './canonical-receipt.js';
import { dirname } from 'node:path';
import { addressArtifactSet, bindAddressArtifacts } from './address-artifacts.js';
import assert from 'node:assert/strict';
import { deriveProfileIdentity, type ProfileIdentity, type ProfileIdentityConfig, type TableIdentityConfig } from '../../packages/protocol/src/index.js';

export const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';
export const entryPoint = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as const;
export const kernel = '0xd6CEDDe84be40893d153Be9d467CD6aD37875b28' as const;
export const kernelFactory = '0x2577507b78c2008Ff367261CB6285d44ba5eF2E9' as const;
export function artifacts() {
  return addressArtifactSet().find;
}

/** Compare runtime bytecode without assuming compiler placeholders are the actual immutables.
 * Callers must separately check every immutable value through the contract's getters. */
export function matchesRuntime(code: Hex, artifact: Artifact) {
  if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) return false;
  let actual = code.slice(2); let expected = artifact.evm.deployedBytecode.object.replace(/^0x/, '');
  if (actual.length !== expected.length) return false;
  const references = (artifact.evm.deployedBytecode as { immutableReferences?: Record<string, { start: number; length: number }[]> }).immutableReferences ?? {};
  for (const locations of Object.values(references)) for (const { start, length } of locations) {
    actual = actual.slice(0, start * 2) + '0'.repeat(length * 2) + actual.slice((start + length) * 2);
    expected = expected.slice(0, start * 2) + '0'.repeat(length * 2) + expected.slice((start + length) * 2);
  }
  return actual.toLowerCase() === expected.toLowerCase();
}

/** Match account inputs to the explicit infrastructure already checked on chain. */
export function assertLiveConfig(config: TableIdentityConfig | ProfileIdentityConfig, infrastructure: { tableFactory: Address; profilePreparationFactory: Address }) {
  bindAddressArtifacts(config);
  assert.equal(config.chainId, 84532, 'Expected Base Sepolia identity configuration');
  assert.equal(config.entryPoint.toLowerCase(), entryPoint.toLowerCase(), 'Identity EntryPoint differs from checked infrastructure');
  assert.equal(config.kernelImplementation.toLowerCase(), kernel.toLowerCase(), 'Identity Kernel differs from checked infrastructure');
  assert.equal(config.tableFactory.toLowerCase(), infrastructure.tableFactory.toLowerCase(), 'Identity table factory differs from checked infrastructure');
  if ('profile' in config) assert.equal(config.profilePreparationFactory.toLowerCase(), infrastructure.profilePreparationFactory.toLowerCase(), 'Identity preparation factory differs from checked infrastructure');
  else assert.equal(config.kernelFactory.toLowerCase(), kernelFactory.toLowerCase(), 'Identity Kernel factory differs from checked infrastructure');
}

/** Verify current prepared profile code and immutable bindings before review or
 * funding. A manifest's prior observation is not a substitute for these reads. */
export async function verifyPreparedProfile(client: Pick<PublicClient, 'getChainId' | 'getCode' | 'readContract'>, config: ProfileIdentityConfig, identity: ProfileIdentity, blockNumber?: bigint) {
  bindAddressArtifacts(config);
  assert.equal(await client.getChainId(), config.chainId, 'Prepared profile chain differs from configuration');
  const predicted = deriveProfileIdentity(identity.publicKey, identity.protectedHeaders, config);
  assert.equal(json(predicted).toLowerCase(), json(identity).toLowerCase(), 'Prepared profile prediction differs');
  const find = artifacts(), at = blockNumber === undefined ? {} : { blockNumber };
  const verify = async (address: Address, contract: string, bindings: readonly (readonly [string, string])[]) => {
    assert.ok(matchesRuntime((await client.getCode({ address, ...at }))!, find(contract)), `${contract} runtime differs from current artifact`);
    for (const [functionName, expected] of bindings) {
      const actual = await client.readContract({ address, abi: find(contract).abi as Abi, functionName, ...at });
      assert.equal(String(actual).toLowerCase(), expected.toLowerCase(), `${contract}.${functionName} differs from configuration`);
    }
  };
  await verify(config.tableFactory, 'PreparedTableFactory', [['entryPoint', config.entryPoint]]);
  await verify(config.profilePreparationFactory, 'ProfilePreparationFactory', [['implementation', config.kernelImplementation], ['tableFactory', config.tableFactory]]);
  await verify(identity.profileFactory, 'ProfileAccountFactory', [['implementation', config.kernelImplementation], ['entryPoint', config.entryPoint], ['validator', identity.validator], ['hook', identity.hook], ['profileHash', identity.profileHash], ['initializeData', identity.initializeData]]);
  await verify(identity.validator, 'PreparedTableValidator', [['entryPoint', config.entryPoint], ['publicKey', identity.publicKey], ['protectedHeaderHash', keccak256(identity.protectedHeaders)]]);
  if (config.profile === 'restricted') {
    const policyCode = await client.getCode({ address: config.policy, ...at });
    assert.ok(policyCode && policyCode !== '0x' && keccak256(policyCode) === config.policyCodeHash, 'Prepared policy bytecode differs from configuration');
    await verify(identity.hook, 'RestrictedExecutionHook', [['entryPoint', config.entryPoint], ['policy', config.policy], ['policyCodeHash', config.policyCodeHash], ['configHash', keccak256(config.policyConfig)], ['configuration', config.policyConfig]]);
  }
}

interface LiveContext {
  account: PrivateKeyAccount;
  client: PublicClient<Transport, typeof baseSepolia>;
  wallet: WalletClient<Transport, typeof baseSepolia, PrivateKeyAccount>;
  find: (name: string) => Artifact;
  tableFactory: Address;
  profilePreparationFactory: Address;
  counter: Address;
  release: () => void;
  journalFile: string;
  transact: (id: string, intent: { to?: Address; data: Hex; value?: bigint }, send: boolean) => Promise<TransactionReceipt | undefined>;
}
export async function liveContext(keyFile: string, variable: string, options: { manifest: string; journal: string; independentSubmitter?: boolean }): Promise<LiveContext> {
  const { account } = loadSubmitter(keyFile, variable);
  const transport = http(process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org', { retryCount: 0 });
  const client = createPublicClient({ chain: baseSepolia, transport, pollingInterval: 1500 });
  const wallet = createWalletClient({ chain: baseSepolia, transport, account });
  if (await client.getChainId() !== 84532) throw new Error('Expected Base Sepolia');
  if (!options.manifest || !options.journal) throw new Error('Explicit infrastructure manifest and transaction journal paths are required');
  const setup = JSON.parse(readFileSync(options.manifest, 'utf8'));
  if (setup.kind !== 'reusable-infrastructure-deployment' || setup.addressDerivationMode !== 'portable' || setup.chainId !== 84532 || setup.allDeploymentsChecked !== true) throw new Error('Verified current Base Sepolia infrastructure manifest required');
  assert.deepEqual(setup.artifactIdentity, addressArtifactSet().identity, 'Infrastructure artifact identity changed');
  const sameDeployer = setup.deployer.toLowerCase() === account.address.toLowerCase();
  if (!sameDeployer && !options.independentSubmitter) throw new Error('Submitter differs from the infrastructure deployer');
  const upstream = JSON.parse(readFileSync('versions.json', 'utf8')).baseSepolia.upstreamAddresses;
  for (const { address, runtimeCodeHash } of Object.values(upstream) as { address: Address; runtimeCodeHash: Hex }[]) {
    const code = await client.getCode({ address });
    if (!code || keccak256(code) !== runtimeCodeHash) throw new Error('Pinned protocol bytecode changed');
  }
  if (setup.protocol.entryPoint.toLowerCase() !== entryPoint.toLowerCase() || setup.protocol.kernel.toLowerCase() !== kernel.toLowerCase()) throw new Error('Infrastructure protocol bindings changed');
  const find = artifacts();
  for (const [name, deployment] of Object.entries(setup.deployments) as [string, any][]) {
    if (deployment.status !== 'deployed-and-runtime-checked') throw new Error('Infrastructure has an unfinished deployment');
    const code = await client.getCode({ address: deployment.predicted });
    if (!code || keccak256(code) !== deployment.runtimeCodeHash || !matchesRuntime(code, find(name))) throw new Error('Infrastructure deployment bytecode changed');
  }
  const tableFactory = setup.deployments.PreparedTableFactory.predicted as Address;
  if ((await client.readContract({ address: tableFactory, abi: find('PreparedTableFactory').abi as Abi, functionName: 'entryPoint' }) as Address).toLowerCase() !== entryPoint.toLowerCase()) throw new Error('Factory EntryPoint changed');
  const preparation = setup.deployments.ProfilePreparationFactory.predicted as Address;
  for (const [name, expected] of [['implementation', kernel], ['tableFactory', tableFactory]] as const) {
    if (String(await client.readContract({ address: preparation, abi: find('ProfilePreparationFactory').abi as Abi, functionName: name })).toLowerCase() !== expected.toLowerCase()) throw new Error('Preparation immutable changed');
  }
  const signerCode = await client.getCode({ address: account.address });
  if (signerCode && signerCode !== '0x') throw new Error('Expected ordinary test submitter');
  const journalFile = options.journal;
  const journal = existsSync(journalFile) ? JSON.parse(readFileSync(journalFile, 'utf8')) : { chainId: 84532, submitter: account.address, transactions: {} };
  if (journal.chainId !== 84532 || typeof journal.submitter !== 'string' || journal.submitter.toLowerCase() !== account.address.toLowerCase() || !journal.transactions || typeof journal.transactions !== 'object' || Array.isArray(journal.transactions)) throw new Error('Wrong transaction journal');
  for (const record of [...Object.values(setup.deployments), ...Object.values(journal.transactions)] as any[]) if (!Number.isSafeInteger(record.nonce) || record.nonce < 0) throw new Error('Invalid reserved transaction nonce');
  const counter = setup.deployments.ExperimentCounter?.predicted;
  assert.match(counter ?? '', /^0x[0-9a-fA-F]{40}$/, 'Infrastructure counter is missing');
  // This command runner is sequential. A lock prevents another local process
  // from reserving the same submitter nonce while an RPC response is stale.
  mkdirSync('.local', { recursive: true });
  const lockFile = `.local/submitters/84532-${account.address.toLowerCase()}.lock`;
  mkdirSync(dirname(lockFile), { recursive: true });
  const lock = openSync(lockFile, 'wx', 0o600);
  writeFileSync(lock, String(process.pid));
  let released = false;
  const release = () => { if (!released) { released = true; closeSync(lock); unlinkSync(lockFile); process.removeListener('exit', release); } };
  process.once('exit', release);
  const save = () => { mkdirSync(dirname(journalFile), { recursive: true }); writeFileSync(journalFile, json(journal)); };
  async function transact(id: string, intent: { to?: Address; data: Hex; value?: bigint }, send: boolean) {
    const intentHash = keccak256(new TextEncoder().encode(json({ ...intent, value: intent.value ?? 0n })));
    const existing = journal.transactions[id];
    if (existing) {
      if (existing.intentHash !== intentHash) throw new Error('Transaction intent changed');
      const receipt = await canonicalReceipt(client, existing.transactionHash);
      existing.receipt = receipt; existing.status = receipt.status; save();
      if (receipt.status !== 'success') throw new Error('Recorded test transaction reverted');
      return receipt;
    }
    const gas = (await client.estimateGas({ account, ...intent })) * 115n / 100n;
    const fees = await client.estimateFeesPerGas();
    if (gas > 16_000_000n || gas * fees.maxFeePerGas > parseEther('0.0015') || (intent.value ?? 0n) > parseEther('0.001')) throw new Error('Test transaction exceeds funding cap');
    if (await client.getBalance({ address: account.address }) < gas * fees.maxFeePerGas + (intent.value ?? 0n)) throw new Error('Insufficient test funding');
    console.log(json({ id, mode: send ? 'submit' : 'preview', to: intent.to, valueWei: intent.value ?? 0n, gasLimit: gas, maximumExecutionFeeWei: gas * fees.maxFeePerGas }));
    if (!send) return;
    const reserved = [...(sameDeployer ? Object.values(setup.deployments) : []), ...Object.values(journal.transactions)].map((record: any) => Number(record.nonce));
    const nonce = Math.max(await client.getTransactionCount({ address: account.address, blockTag: 'pending' }), Math.max(-1, ...reserved) + 1);
    const request = await wallet.prepareTransactionRequest({ ...intent, gas, nonce, ...fees });
    const serializedTransaction = await wallet.signTransaction(request); const hash = keccak256(serializedTransaction);
    journal.transactions[id] = { intentHash, ...intent, value: intent.value ?? 0n, nonce, gas, ...fees, transactionHash: hash, status: 'signed-awaiting-broadcast-result' }; save();
    if (await wallet.sendRawTransaction({ serializedTransaction }) !== hash) throw new Error('Broadcast hash mismatch');
    journal.transactions[id].status = 'broadcast'; save();
    console.log(json({ id, transactionHash: hash }));
    const receipt = await canonicalReceipt(client, hash);
    journal.transactions[id].receipt = receipt; journal.transactions[id].status = receipt.status; save();
    if (receipt.status !== 'success') throw new Error('Test transaction reverted');
    return receipt;
  }
  return { account, client, wallet, find, tableFactory, profilePreparationFactory: preparation, counter: counter as Address, transact, release, journalFile };
}
