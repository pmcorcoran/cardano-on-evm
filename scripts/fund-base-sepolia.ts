import { parseArgs } from 'node:util';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, parseAbi, parseEther, type Hex } from 'viem';
import { baseSepolia, sepolia } from 'viem/chains';
import { getL2TransactionHashes } from 'viem/op-stack';
import { loadSubmitter } from './lib/submitter.js';
import { releaseEvidenceOutput } from './lib/release-evidence.js';

// Testnet-only deposit to the SAME submitter address, through the official
// Base Sepolia portal. Default is a read-only preview; --send broadcasts once.
// https://docs.base.org/specifications/reference/base-contracts
const portal = '0x49f53e41452C74589E85cA1677426Ba426459e85' as const;
const portalAbi = parseAbi(['function depositTransaction(address to,uint256 value,uint64 gasLimit,bool isCreation,bytes data) payable']);
try {
  const { values } = parseArgs({ options: { 'key-file': { type: 'string' }, 'key-variable': { type: 'string', default: 'SUBMITTER_PRIVATE_KEY' }, journal: { type: 'string' }, 'amount-eth': { type: 'string', default: '0.005' }, send: { type: 'boolean', default: false }, status: { type: 'boolean', default: false } } });
  if (!values['key-file'] || !values.journal) throw new Error('Supply --key-file and --journal');
  const evidenceFile = resolve(values.journal);
  if (!evidenceFile.endsWith('.json')) throw new Error('The explicit deposit journal must be a JSON file');
  if (existsSync(evidenceFile)) {
    const stat = lstatSync(evidenceFile);
    if (!stat.isFile() || stat.nlink !== 1 || realpathSync(evidenceFile) !== evidenceFile || evidenceFile === realpathSync(values['key-file'])) throw new Error('Deposit journal must be a regular file separate from credentials');
  } else releaseEvidenceOutput(evidenceFile, [values['key-file']]);
  const save = (value: object) => writeFileSync(evidenceFile, JSON.stringify(value, null, 2) + '\n');
  const { account, config } = loadSubmitter(values['key-file'], values['key-variable']!);
  const l1Transport = http(config.ETHEREUM_SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com', { retryCount: 0 });
  const l1 = createPublicClient({ chain: sepolia, transport: l1Transport });
  const l2 = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org', { retryCount: 0 }) });
  if (await l1.getChainId() !== 11155111 || await l2.getChainId() !== 84532) throw new Error('Wrong testnet chain IDs');
  const previous = existsSync(evidenceFile) ? JSON.parse(readFileSync(evidenceFile, 'utf8')) : undefined;
  if (previous && (previous.kind !== 'base-sepolia-self-deposit' || previous.fromChainId !== 11155111 || previous.toChainId !== 84532 || previous.portal?.toLowerCase() !== portal.toLowerCase() || previous.from?.toLowerCase() !== account.address.toLowerCase() || previous.to?.toLowerCase() !== account.address.toLowerCase())) throw new Error('Deposit journal does not match this submitter and bridge');
  if (previous?.l1TransactionHash || values.status) {
    if (!previous?.l1TransactionHash || previous.to.toLowerCase() !== account.address.toLowerCase()) throw new Error('No matching existing deposit');
    const receipt = await l1.getTransactionReceipt({ hash: previous.l1TransactionHash });
    if (receipt.status !== 'success') throw new Error('L1 deposit transaction failed');
    const hashes = getL2TransactionHashes({ logs: receipt.logs.filter((log) => log.address.toLowerCase() === portal.toLowerCase()) });
    if (hashes.length !== 1) throw new Error('Expected one portal deposit');
    let l2Receipt;
    try { l2Receipt = await l2.getTransactionReceipt({ hash: hashes[0]! }); } catch { /* deposit may still be deriving */ }
    const evidence = { ...previous, status: l2Receipt?.status === 'success' ? 'credited-on-base-sepolia' : 'awaiting-base-sepolia-receipt', checkedAt: new Date().toISOString(), l1Receipt: receipt, l2TransactionHash: hashes[0], l2Receipt: l2Receipt ?? null, baseBalanceWei: (await l2.getBalance({ address: account.address })).toString() };
    const serializable = JSON.parse(JSON.stringify(evidence, (_, value) => typeof value === 'bigint' ? value.toString() : value));
    save(serializable);
    console.log(JSON.stringify({ status: evidence.status, l1TransactionHash: previous.l1TransactionHash, l2TransactionHash: hashes[0], baseBalanceWei: evidence.baseBalanceWei, evidenceFile }, null, 2));
  } else {
    const value = parseEther(values['amount-eth']!);
    if (value <= 0n || value > parseEther('0.01')) throw new Error('This acceptance-funding script limits deposits to 0.01 test ETH');
    if (baseSepolia.contracts.portal[11155111].address.toLowerCase() !== portal.toLowerCase()) throw new Error('Pinned SDK portal mismatch');
    const code = await l1.getCode({ address: portal });
    if (!code || code === '0x') throw new Error('Portal has no bytecode');
    const destinationCode = await l2.getCode({ address: account.address });
    if (destinationCode && destinationCode !== '0x') throw new Error('This script requires a plain recipient EOA');
    const data = encodeFunctionData({ abi: portalAbi, functionName: 'depositTransaction', args: [account.address, value, 100_000n, false, '0x'] });
    await l1.call({ to: portal, account, value, data });
    const gasEstimate = await l1.estimateGas({ to: portal, account, value, data });
    const fees = await l1.estimateFeesPerGas();
    if (fees.maxFeePerGas > 2_000_000_000n || gasEstimate > 500_000n) throw new Error('Estimated funding fee exceeds the test-run cap');
    const gas = gasEstimate * 12n / 10n;
    if (await l1.getBalance({ address: account.address }) < value + gas * fees.maxFeePerGas) throw new Error('Insufficient Sepolia ETH');
    const evidence = { kind: 'base-sepolia-self-deposit', status: 'prepared', timestamp: new Date().toISOString(), fromChainId: 11155111, toChainId: 84532, from: account.address, to: account.address, portal, portalCodeHash: keccak256(code), valueWei: value.toString(), gasLimit: gas.toString(), maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(), maximumL1GasCostWei: (gas * fees.maxFeePerGas).toString(), source: 'https://docs.base.org/specifications/reference/base-contracts' };
    save(evidence); console.log(JSON.stringify(evidence, null, 2));
    if (values.send) {
      const wallet = createWalletClient({ chain: sepolia, transport: l1Transport, account });
      const request = await wallet.prepareTransactionRequest({ to: portal, value, data, gas, ...fees });
      const serialized = await wallet.signTransaction(request);
      const hash: Hex = keccak256(serialized);
      // Journal the hash before broadcast. A rerun observes this transaction;
      // it never creates a second deposit after an ambiguous network failure.
      save({ ...evidence, status: 'signed-awaiting-broadcast-result', l1TransactionHash: hash, nonce: request.nonce });
      const submitted = await wallet.sendRawTransaction({ serializedTransaction: serialized });
      if (submitted !== hash) throw new Error('Broadcast hash mismatch');
      save({ ...evidence, status: 'broadcast', l1TransactionHash: hash, nonce: request.nonce });
      console.log(JSON.stringify({ status: 'broadcast', l1TransactionHash: hash, evidenceFile }, null, 2));
    }
  }
} catch {
  // Never render a viem error: it may include the credential-bearing RPC URL.
  console.error('Base Sepolia funding step failed. Details containing local configuration were withheld; inspect the public evidence record before retrying.');
  process.exitCode = 1;
}
