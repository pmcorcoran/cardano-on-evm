import '../scripts/experiments/errors.js';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { createPublicClient, createWalletClient, http, encodeDeployData, getCreateAddress, getAddress, keccak256, parseEther, stringToHex, toFunctionSelector, zeroAddress, zeroHash, type Abi, type Address, type Hex, type Chain } from 'viem';
import { base, baseSepolia, foundry } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { loadSubmitter } from '../scripts/lib/submitter.js';
import { artifacts, matchesRuntime, json } from '../scripts/lib/live-context.js';
import { canonicalReceipt } from '../scripts/lib/canonical-receipt.js';
import { encodeTargetAllowlist, encodeSelectorAllowlist } from '../packages/protocol/src/index.js';
import { addressArtifactSet, bindAddressArtifacts } from '../scripts/lib/address-artifacts.js';
import type { ProfileIdentityConfig } from '../packages/protocol/src/index.js';

const { values } = parseArgs({ options: { network: { type: 'string', default: 'local' }, out: { type: 'string', default: '.local/example-infrastructure.json' }, 'entrypoint-artifact': { type: 'string', default: 'vendor/entrypoint-v07/artifacts/EntryPoint.json' }, deployer: { type: 'string' }, recipient: { type: 'string' }, 'key-file': { type: 'string' }, 'key-variable': { type: 'string', default: 'SUBMITTER_PRIVATE_KEY' }, send: { type: 'boolean', default: false } } });
assert.ok(['local', 'base-sepolia', 'base-mainnet'].includes(values.network!));
const local = values.network === 'local', mainnet = values.network === 'base-mainnet';
assert.ok(!(mainnet && values.send), 'Mainnet delivery is an unsigned plan; mainnet deployment is outside this acceptance project');
const chain: Chain = local ? foundry : mainnet ? base : baseSepolia;
const url = local ? process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8545' : mainnet ? process.env.BASE_MAINNET_RPC_URL ?? 'https://mainnet.base.org' : process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org';
const account = local ? privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') : values['key-file'] ? loadSubmitter(values['key-file'], values['key-variable']!).account : undefined;
assert.ok(account || values.deployer, 'An unsigned network plan requires --deployer=0xADDRESS');
const deployer = account?.address ?? getAddress(values.deployer!);
const client = createPublicClient({ chain, transport: http(url), pollingInterval: local ? 50 : 1500 });
const wallet = account ? createWalletClient({ chain, transport: http(url), account }) : undefined;
assert.equal(await client.getChainId(), chain.id);
assert.ok(!values.send || wallet, 'Sending needs an operator-owned test submitter key');
const send = local || values.send, find = artifacts(), file = values.out!;
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
const published = (mainnet ? versions.baseMainnet : versions.baseSepolia).upstreamAddresses;
const state: any = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { kind: 'reusable-infrastructure-deployment', addressDerivationMode: 'portable', artifactIdentity: addressArtifactSet().identity, chainId: chain.id, deployer, startNonce: await client.getTransactionCount({ address: deployer, blockTag: 'pending' }), deployments: {} };
assert.equal(state.addressDerivationMode, 'portable', 'Infrastructure manifests must describe portable derivation');
assert.deepEqual(state.artifactIdentity, addressArtifactSet().identity, 'Infrastructure manifest artifact identity differs from current build');
assert.equal(state.chainId, chain.id); assert.equal(state.deployer, deployer);
const save = () => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, json(state)); };
let offset = 0;
async function deploy(name: string, args: readonly unknown[] = []) {
  const a = name === 'EntryPoint' ? JSON.parse(readFileSync(values['entrypoint-artifact']!, 'utf8')) : find(name);
  const bytecode: Hex = name === 'EntryPoint' ? a.bytecode : `0x${a.evm.bytecode.object}`;
  const data = encodeDeployData({ abi: a.abi as Abi, bytecode, args });
  const nonce = state.startNonce + offset++, predicted = getCreateAddress({ from: deployer, nonce: BigInt(nonce) });
  let record = state.deployments[name];
  if (record) { assert.equal(record.data, data); assert.equal(record.nonce, nonce); }
  else { record = state.deployments[name] = { nonce, predicted, data, dataHash: keccak256(data), status: 'unsigned-plan' }; save(); }
  if (!record.transactionHash && send) {
    assert.equal(await client.getTransactionCount({ address: deployer, blockTag: 'pending' }), nonce, 'Use a dedicated deployer; its nonce changed');
    const gas = (await client.estimateGas({ account: account!, data })) * 115n / 100n;
    const fees = await client.estimateFeesPerGas();
    assert.ok(gas <= 16000000n && (local || gas * fees.maxFeePerGas <= parseEther('0.0015')), 'Deployment exceeds the bounded test budget');
    const transaction = await wallet!.prepareTransactionRequest({ account: account!, chain, nonce, data, gas, ...fees });
    const signed = await wallet!.signTransaction(transaction);
    record.transactionHash = keccak256(signed); record.status = 'broadcast-result-unknown'; save();
    assert.equal(await wallet!.sendRawTransaction({ serializedTransaction: signed }), record.transactionHash);
  }
  if (record.transactionHash) {
    const receipt = await canonicalReceipt(client as any, record.transactionHash);
    assert.equal(receipt.status, 'success'); assert.equal(receipt.contractAddress?.toLowerCase(), predicted.toLowerCase());
    const code = await client.getCode({ address: predicted, blockNumber: receipt.blockNumber }); assert.ok(code);
    if (name !== 'EntryPoint') assert.ok(matchesRuntime(code, a));
    else if (a.evm) {
      assert.ok(matchesRuntime(code, a));
      const creator = getCreateAddress({ from: predicted, nonce: 1n });
      for (const refs of Object.values(a.evm.deployedBytecode.immutableReferences) as { start: number; length: number }[][]) for (const { start, length } of refs) {
        assert.equal(length, 32);
        assert.equal(code.slice(2 + start * 2, 2 + (start + length) * 2).toLowerCase(), creator.slice(2).toLowerCase().padStart(64, '0'));
      }
      assert.ok(await client.getCode({ address: creator, blockNumber: receipt.blockNumber }));
    }
    record.status = 'deployed-and-runtime-checked'; record.receipt = receipt; record.runtimeCodeHash = keccak256(code); save();
  }
  console.log(json({ name, address: predicted, status: record.status, transactionHash: record.transactionHash }));
  return predicted;
}
let entryPoint: Address, kernel: Address;
if (local) {
  entryPoint = await deploy('EntryPoint'); kernel = await deploy('Kernel', [entryPoint]);
  await deploy('KernelFactory', [kernel]);
} else {
  for (const value of Object.values(published) as { address: Address; runtimeCodeHash: Hex }[]) assert.equal(keccak256((await client.getCode({ address: value.address }))!), value.runtimeCodeHash);
  entryPoint = published.entryPoint.address; kernel = published.kernelImplementation.address;
}
assert.equal(String(await client.readContract({ address: kernel, abi: find('Kernel').abi as Abi, functionName: 'entrypoint' })).toLowerCase(), entryPoint.toLowerCase());
const tableFactory = await deploy('PreparedTableFactory', [entryPoint]);
const preparationFactory = await deploy('ProfilePreparationFactory', [kernel, tableFactory]);
const targetPolicy = await deploy('TargetAllowlistPolicy'), selectorPolicy = await deploy('SelectorAllowlistPolicy'), counter = await deploy('ExperimentCounter');
if (send) {
  assert.equal(String(await client.readContract({ address: tableFactory, abi: find('PreparedTableFactory').abi as Abi, functionName: 'entryPoint' })).toLowerCase(), entryPoint.toLowerCase());
  for (const [name, expected] of [['implementation', kernel], ['tableFactory', tableFactory]]) assert.equal(String(await client.readContract({ address: preparationFactory, abi: find('ProfilePreparationFactory').abi as Abi, functionName: name! })).toLowerCase(), expected!.toLowerCase());
}
state.protocol = { entryPoint, kernel }; state.allDeploymentsChecked = Object.values(state.deployments).every((record: any) => record.status === 'deployed-and-runtime-checked'); state.noAccountOwnerCreated = true; save();
const recipient = values.recipient ? getAddress(values.recipient) : deployer;
const profiles = Object.fromEntries(['general', 'targets', 'selectors'].map((name) => {
  const policy = name === 'general' ? zeroAddress : name === 'targets' ? targetPolicy : selectorPolicy;
  const policyName = name === 'targets' ? 'TargetAllowlistPolicy' : 'SelectorAllowlistPolicy';
  const config: ProfileIdentityConfig = { profile: name === 'general' ? 'general' : 'restricted', chainId: chain.id, entryPoint, kernelImplementation: kernel, tableFactory, profilePreparationFactory: preparationFactory,
    validatorCreationCode: `0x${find('PreparedTableValidator').evm.bytecode.object}`, profileFactoryCreationCode: `0x${find('ProfileAccountFactory').evm.bytecode.object}`,
    namespace: keccak256(stringToHex('cardano-kernel:reference:v1')), index: 0n, policy,
    policyConfig: name === 'general' ? '0x' : name === 'targets' ? encodeTargetAllowlist([counter, recipient]) : encodeSelectorAllowlist([{ target: counter, selectors: [toFunctionSelector('increment(uint256)')], allowEmpty: false, allowValue: false }, { target: recipient, selectors: [], allowEmpty: true, allowValue: true }]),
    policyCodeHash: name === 'general' ? zeroHash : keccak256(`0x${find(policyName).evm.deployedBytecode.object}`) };
  return [name, { config, artifactBinding: bindAddressArtifacts(config), counter, permittedRecipient: recipient }];
}));
writeFileSync(`${file}.profiles.json`, json({ kind: 'reference-application-profile-manifest', addressDerivationMode: 'portable', artifactIdentity: state.artifactIdentity, chainId: chain.id, infrastructureVerified: state.allDeploymentsChecked, profiles }));
console.log(json({ file, chainId: chain.id, mode: send ? 'deploy-and-verify' : 'unsigned-plan', allDeploymentsChecked: state.allDeploymentsChecked }));
