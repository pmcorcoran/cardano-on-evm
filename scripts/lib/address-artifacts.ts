import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getAddress, type Hex } from 'viem';
import { profileConfigHash, tableConfigHash, type ProfileIdentityConfig, type TableIdentityConfig } from '../../packages/protocol/src/index.js';
import type { Artifact } from '../build-contracts.js';

const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const names = ['PreparedTableValidator', 'PreparedTableFactory', 'ProfileAccountFactory', 'ProfilePreparationFactory', 'Kernel', 'KernelFactory', 'RestrictedExecutionHook', 'TargetAllowlistPolicy', 'SelectorAllowlistPolicy'] as const;
type IdentityConfig = TableIdentityConfig | ProfileIdentityConfig;
export interface AddressArtifactIdentity {
  addressDerivationMode: 'portable';
  contractsSha256: string;
  buildSha256: string;
  artifacts: { name: string; artifactSha256: string; creationSha256: string; runtimeTemplateSha256: string }[];
}

/** Read the current compiled artifact set and its exact build identity. */
export function addressArtifactSet() {
  const raw = readFileSync('artifacts/contracts.json'), buildBytes = readFileSync('artifacts/build.json');
  const all = JSON.parse(raw.toString()) as Record<string, Record<string, Artifact>>;
  const build = JSON.parse(buildBytes.toString());
  assert.equal(build.addressDerivationMode, 'portable', 'Contract build must describe portable derivation');
  const find = (name: string): Artifact => {
    const matches = Object.values(all).flatMap((file) => Object.entries(file)).filter(([key]) => key === name);
    assert.equal(matches.length, 1, `Ambiguous contract artifact: ${name}`);
    return matches[0]![1];
  };
  const identity: AddressArtifactIdentity = {
    addressDerivationMode: 'portable', contractsSha256: sha(raw), buildSha256: sha(buildBytes),
    artifacts: names.map((name) => {
      const a = find(name);
      for (const [kind, bytecode] of [['creation', a.evm.bytecode], ['runtime', a.evm.deployedBytecode]] as const) {
        assert.match(bytecode.object, /^(?:[a-fA-F0-9]{2})+$/, `${name} ${kind} must be linked`);
        assert.deepEqual(bytecode.linkReferences ?? {}, {}, `${name} ${kind} has unresolved links`);
      }
      return { name, artifactSha256: sha(JSON.stringify(a)), creationSha256: sha(Buffer.from(a.evm.bytecode.object, 'hex')), runtimeTemplateSha256: sha(Buffer.from(a.evm.deployedBytecode.object, 'hex')) };
    }),
  };
  return { addressDerivationMode: 'portable' as const, find, identity };
}

export interface AddressArtifactBinding {
  addressDerivationMode: 'portable';
  artifactIdentity: AddressArtifactIdentity;
  factories: Record<string, string>;
}
export function bindAddressArtifacts(config: IdentityConfig): AddressArtifactBinding {
  // Configuration validation also rejects unsupported fields before callers can
  // use a manifest as an authorization or signing input.
  if ('profile' in config) profileConfigHash(config); else tableConfigHash(config);
  const selected = addressArtifactSet();
  assert.equal(config.validatorCreationCode.toLowerCase(), `0x${selected.find('PreparedTableValidator').evm.bytecode.object}`.toLowerCase(), 'Validator creation bytes do not match current artifact');
  if ('profile' in config) assert.equal(config.profileFactoryCreationCode.toLowerCase(), `0x${selected.find('ProfileAccountFactory').evm.bytecode.object}`.toLowerCase(), 'Profile factory creation bytes do not match current artifact');
  return { addressDerivationMode: 'portable', artifactIdentity: selected.identity, factories: Object.fromEntries([
    ['entryPoint', config.entryPoint], ['kernelImplementation', config.kernelImplementation], ['tableFactory', config.tableFactory],
    'profile' in config ? ['profilePreparationFactory', config.profilePreparationFactory] : ['kernelFactory', config.kernelFactory],
  ].map(([name, address]) => [name!, getAddress(address!).toLowerCase()])) };
}

/** Reject missing metadata, unknown builds, changed bytes or factory addresses. */
export function verifyAddressArtifactBinding(config: IdentityConfig, binding: AddressArtifactBinding): void {
  assert.ok(binding && typeof binding === 'object', 'Manifest must record its address artifact binding');
  assert.equal(binding.addressDerivationMode, 'portable', 'Address artifact metadata must describe portable derivation');
  const expected = bindAddressArtifacts(config);
  assert.deepEqual(binding.artifactIdentity, expected.artifactIdentity, 'Unrecognized or inconsistent artifact identity');
  assert.deepEqual(binding.factories, expected.factories, 'Recorded factory addresses differ from identity configuration');
}

export const creationBytecode = (artifact: Artifact): Hex => `0x${artifact.evm.bytecode.object}`;
