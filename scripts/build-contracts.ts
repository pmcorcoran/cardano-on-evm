import { readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import solc from 'solc';
import { createHash } from 'node:crypto';

export interface Artifact {
  abi: readonly unknown[];
  evm: {
    bytecode: { object: string; linkReferences: Record<string, Record<string, { start: number; length: number }[]>> };
    deployedBytecode: { object: string; immutableReferences?: Record<string, { start: number; length: number }[]>; linkReferences?: Record<string, Record<string, { start: number; length: number }[]>> };
  };
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(`${dir}/${e.name}`) : e.name.endsWith('.sol') ? [`${dir}/${e.name}`] : []);
}
export function compileContracts(): Record<string, Record<string, Artifact>> {
  const settings = {
    optimizer: { enabled: true, runs: 200 }, viaIR: process.argv.includes('--crypto-via-ir'), evmVersion: 'cancun',
    metadata: { bytecodeHash: 'none', appendCBOR: false },
    remappings: ['solady/=vendor/solady/src/', 'ExcessivelySafeCall/=vendor/excessively-safe-call/src/', '@solidity/=vendor/scl/src/'],
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode'] } },
  };
  const sources = Object.fromEntries(files('contracts').map((f) => [f, { content: readFileSync(f, 'utf8') }]));
  const resolvedSources = new Map(Object.entries(sources).map(([file, { content }]) => [file, content]));
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
  const resolver = {
    import: (file: string) => {
      try {
        const contents = readFileSync(path.resolve(file), 'utf8');
        resolvedSources.set(file, contents);
        return { contents };
      }
      catch { return { error: `Missing pinned dependency: ${file}` }; }
    },
  };
  const input = JSON.stringify({ language: 'Solidity', sources, settings });
  const output = JSON.parse(solc.compile(input, resolver));
  const errors = (output.errors ?? []).filter((e: { severity: string }) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join('\n'));
  // Upstream Kernel's deployment profile uses via-IR. Keep the cryptography on
  // its measured non-IR profile; never relax the chain's EIP-170 code-size limit.
  const kernelSources = Object.fromEntries(['vendor/kernel/src/Kernel.sol', 'vendor/kernel/src/factory/KernelFactory.sol'].map((f) => [f, { content: readFileSync(f, 'utf8') }]));
  for (const [file, { content }] of Object.entries(kernelSources)) resolvedSources.set(file, content);
  const kernelSettings = { ...settings, viaIR: true };
  const kernelInput = JSON.stringify({ language: 'Solidity', sources: kernelSources, settings: kernelSettings });
  const kernelOutput = JSON.parse(solc.compile(kernelInput, resolver));
  const kernelErrors = (kernelOutput.errors ?? []).filter((e: { severity: string }) => e.severity === 'error');
  if (kernelErrors.length) throw new Error(kernelErrors.map((e: { formattedMessage: string }) => e.formattedMessage).join('\n'));
  for (const source of Object.keys(kernelSources)) output.contracts[source] = kernelOutput.contracts[source];
  // Pin the current creation/runtime bytes independently of compiler success.
  const bytecodePins = JSON.parse(readFileSync('fixtures/contract-bytecode-pins.json', 'utf8'));
  for (const [name, pin] of Object.entries(bytecodePins) as [string, { source: string; creationSha256: string; runtimeTemplateSha256: string }][]) {
    const artifact = output.contracts[pin.source][name];
    const sha = (hex: string) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
    if (sha(artifact.evm.bytecode.object) !== pin.creationSha256 || sha(artifact.evm.deployedBytecode.object) !== pin.runtimeTemplateSha256) throw new Error(`Contract bytecode pin mismatch: ${name}`);
  }
  const sourceFiles = [...resolvedSources].sort(([a], [b]) => a.localeCompare(b)).map(([file, contents]) => ({ file, sha256: sha256(contents) }));
  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/contracts.json', JSON.stringify(output.contracts, null, 2));
  writeFileSync('artifacts/build.json', JSON.stringify({ compiler: solc.version(), addressDerivationMode: 'portable', settings, kernelSettings, compilerInputSha256: sha256(input), kernelCompilerInputSha256: sha256(kernelInput), sourceInventorySha256: sha256(JSON.stringify(sourceFiles)), sourceFiles, warnings: [...(output.errors ?? []), ...(kernelOutput.errors ?? [])] }, null, 2));
  return output.contracts;
}
if (process.argv[1]?.endsWith('build-contracts.ts')) {
  const contracts = compileContracts();
  console.log(`Compiled ${Object.values(contracts).reduce((n, c) => n + Object.keys(c).length, 0)} contracts with solc ${solc.version()}`);
}
