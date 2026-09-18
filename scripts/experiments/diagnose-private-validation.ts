import './errors.js';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { createPublicClient, http, encodeFunctionData, zeroAddress } from 'viem';
import { operationFromJson, packOperation } from '../../packages/protocol/src/index.js';
import { json } from '../lib/live-context.js';

// Read-only parser diagnosis of explicit generated, saved, or freshly requested
// trace data. The actual pinned worker validates signatures, time bounds, opcodes
// and storage; contract addresses are reported without claiming code-hash checks.
const { values } = parseArgs({ options: { fixture: { type: 'string' }, operation: { type: 'string' }, config: { type: 'string' }, trace: { type: 'string' }, 'rpc-url': { type: 'string' }, out: { type: 'string' }, 'source-worker': { type: 'boolean', default: false } } });
assert.ok(values.out, 'Supply --out for the diagnostic report');
assert.ok(values.fixture ? !values.operation && !values.config && !values.trace && !values['rpc-url'] : values.operation && values.config && (values.trace || values['rpc-url']), 'Supply --fixture, or --operation and --config with --trace or --rpc-url');
const pin = JSON.parse(readFileSync('infra/bundler/upstream.json', 'utf8'));
const root = values['source-worker'] ? `../../infra/bundler/.local/alto-${pin.commit}/src/esm/` : '../../infra/bundler/node_modules/@pimlico/alto/esm/';
const [{ bundlerCollectorTracer }, { getTracerBodyString }, { SafeValidator }, { pimlicoSimulationsAbi }] = await Promise.all([
  import(`${root}rpc/validation/BundlerCollectorTracerV07.js`), import(`${root}rpc/validation/tracer.js`),
  import(`${root}rpc/validation/SafeValidator.js`), import(`${root}types/contracts/PimlicoSimulations.js`),
]);
const fixture = values.fixture ? JSON.parse(readFileSync(values.fixture, 'utf8')) : undefined;
if (fixture) assert.equal(fixture.testData, true, 'A parser fixture must explicitly identify generated test data');
const saved = fixture ?? JSON.parse(readFileSync(values.operation!, 'utf8'));
const operation = operationFromJson(Object.fromEntries(Object.entries(saved.operation).filter(([, value]) => value !== null)));
const config = fixture ? { entryPoint: fixture.entryPoint, worker: { 'entrypoint-simulation-contract-v7': fixture.simulation, 'pimlico-simulation-contract': fixture.pimlico } } : JSON.parse(readFileSync(values.config!, 'utf8'));
const entryPoint = config.entryPoint;
let trace = fixture?.trace;
if (values.trace) {
  const savedTrace = JSON.parse(readFileSync(values.trace, 'utf8'));
  trace = savedTrace.trace ?? savedTrace;
}
if (!trace) {
  const client = createPublicClient({ transport: http(values['rpc-url']!, { timeout: 55000, retryCount: 0 }) });
  assert.ok(Number.isSafeInteger(config.chainId) && config.chainId > 0, 'Configuration requires its chain ID');
  assert.equal(await client.getChainId(), config.chainId);
  const data = encodeFunctionData({ abi: pimlicoSimulationsAbi, functionName: 'simulateValidation', args: [config.worker['entrypoint-simulation-contract-v7'], entryPoint, [], packOperation(operation)] });
  trace = await client.request({ method: 'debug_traceCall' as any, params: [{ from: zeroAddress, to: config.worker['pimlico-simulation-contract'], data }, 'latest', { tracer: getTracerBodyString(bundlerCollectorTracer), timeout: '50s' }] as any });
}
const out: any = { kind: 'private-strict-parser-diagnosis', at: new Date().toISOString(), readOnly: true, chainTransactionsSent: 0, workerVersion: pin.version, sourceCommit: pin.commit, workerBuild: values['source-worker'] ? 'source' : 'package', traceSource: fixture ? 'generated-test-data' : values.trace ? 'supplied-trace' : 'current-rpc-trace', executionEvidence: false, chainId: config.chainId ?? null, trace };
try {
  const worker = Object.create(SafeValidator.prototype);
  worker.config = { publicClient: { request: async () => trace }, entrypointSimulationContractV7: config.worker['entrypoint-simulation-contract-v7'], pimlicoSimulationContract: config.worker['pimlico-simulation-contract'] };
  worker.logger = { info() {}, debug() {} };
  worker.getCodeHashes = async (addresses: string[]) => ({ addresses, hash: '0x' });
  // Alto's V07 shape distinguishes absence from older EntryPoint wire formats.
  const validation = await worker.getValidationResult07({ userOp: { ...operation, factory: operation.factory ?? null, paymaster: operation.paymaster ?? null }, queuedUserOps: [], entryPoint });
  out.strictParser = { passed: true, validation, referencedContractCodeHashesChecked: false };
} catch (error) { out.error = error instanceof Error ? error.message : 'Diagnosis failed'; process.exitCode = 1; }
mkdirSync(dirname(values.out), { recursive: true }); writeFileSync(values.out, json(out));
console.log(json({ file: values.out, traceSource: out.traceSource, outerTraceError: trace.error, strictParserPassed: out.strictParser?.passed ?? false, error: out.error }));
