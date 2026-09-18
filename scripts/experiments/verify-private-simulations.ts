import './errors.js';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { getCreateAddress, keccak256, toHex, type Hex } from 'viem';
import { httpRpc } from '../../packages/submission/src/index.js';
import { matchesRuntime, json } from '../lib/live-context.js';

const { values } = parseArgs({ options: { deployment: { type: 'string' }, 'rpc-url': { type: 'string' }, out: { type: 'string' } } });
assert.ok(values.deployment && values['rpc-url'] && values.out, 'Supply --deployment, --rpc-url and --out');
const setup = JSON.parse(readFileSync(values.deployment, 'utf8'));
assert.ok(Number.isSafeInteger(setup.chainId) && setup.chainId > 0, 'Deployment report requires its chain ID');
assert.ok(['package', 'source'].includes(setup.workerBuild), 'Deployment report must identify its pinned worker build');
const pin = JSON.parse(readFileSync('infra/bundler/upstream.json', 'utf8'));
const artifactRoot = setup.workerBuild === 'source' ? `infra/bundler/.local/alto-${pin.commit}/src/esm/contracts` : 'infra/bundler/node_modules/@pimlico/alto/esm/contracts';
const rpc = httpRpc(values['rpc-url'], { minimumIntervalMs: 100 });
assert.equal(await rpc('eth_chainId', []), toHex(setup.chainId));
const checks = [];
for (const [name, path] of [['EntryPointSimulations07', 'EntryPointSimulations.sol/EntryPointSimulations07'], ['PimlicoSimulations', 'PimlicoSimulations.sol/PimlicoSimulations']]) {
  const deployments = setup.simulations?.filter((item: any) => item.artifact === path);
  assert.equal(deployments?.length, 1, 'Require one current deployment for ' + name);
  const deployment = deployments[0];
  const artifact = JSON.parse(readFileSync(`${artifactRoot}/${path}.json`, 'utf8'));
  assert.equal(deployment.creationCodeHash, keccak256(artifact.bytecode.object), 'Recorded creation hash must match the pinned artifact');
  const code = await rpc('eth_getCode', [deployment.address, 'latest']) as Hex;
  assert.ok(matchesRuntime(code, { evm: { deployedBytecode: artifact.deployedBytecode } } as any));
  assert.equal(keccak256(code), deployment.runtimeCodeHash);
  const transaction = await rpc('eth_getTransactionByHash', [deployment.transactionHash]) as { input: Hex };
  assert.equal(transaction.input.toLowerCase(), artifact.bytecode.object.toLowerCase(), 'Actual deployment used the exact pinned no-argument constructor');
  const references = artifact.deployedBytecode.immutableReferences ?? {}, fields = [];
  if (name === 'EntryPointSimulations07') {
    const creator = getCreateAddress({ from: deployment.address, nonce: 1n });
    // IDs are from this exact npm-pinned artifact. Source declarations are
    // EntryPoint._senderCreator and EntryPointSimulations07.thisContract.
    assert.deepEqual(Object.keys(references).sort(), ['2160', '3803']);
    for (const [id, expected] of [['2160', creator], ['3803', deployment.address]]) {
      for (const position of references[id!]) {
        assert.equal(position.length, 32);
        assert.equal(`0x${code.slice(2 + position.start * 2, 2 + (position.start + 32) * 2)}`.toLowerCase(), toHex(BigInt(expected!), { size: 32 }));
      }
      fields.push({ id, name: id === '2160' ? '_senderCreator' : 'thisContract', expected, allOccurrencesChecked: references[id!].length });
    }
    const creatorCode = await rpc('eth_getCode', [creator, 'latest']) as Hex;
    assert.ok(creatorCode !== '0x');
    fields.push({ senderCreatorRuntimeHash: keccak256(creatorCode), constructorDerivedAddress: creator });
  } else assert.equal(Object.keys(references).length, 0);
  checks.push({ name, address: deployment.address, deploymentTransaction: deployment.transactionHash, actualCreationInputMatchesPinnedArtifact: true, runtimeMatchesPinnedArtifact: true, everyImmutableChecked: true, fields });
}
const output = { kind: 'read-only-private-simulation-code-and-immutable-verification', checkedAt: new Date().toISOString(), chainId: setup.chainId, workerBuild: setup.workerBuild, sourceCommit: pin.commit, chainTransactionsSent: 0, checks };
mkdirSync(dirname(values.out), { recursive: true }); writeFileSync(values.out, json(output)); console.log(json(output));
