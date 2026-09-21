import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, lstat, rm, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';

const run = promisify(execFile), source = process.cwd();
export const names = ['wallet', 'protocol', 'enrollment', 'sdk', 'submission', 'contracts'];
// Keep the runtime-floor and previous consumer coverage alongside the reviewed
// development declarations. This script also runs from standalone library bundles.
export const nodeTypeVersions = ['22.18.0', '24.3.1', '26.6.1'];
export const consumerTypeScriptVersions = ['5.9.2', '7.0.2'];
// Preserve every host library from the original ES2022 consumer target. Node
// 24.3.1's URLPattern declaration conflicts with newer DOM declarations; pin
// the unchanged baseline libraries rather than suppressing declaration checks.
export const consumerHostTypeScriptVersion = '5.9.2';
export const consumerHostLibraries = ['dom', 'webworker.importscripts', 'scripthost', 'dom.iterable', 'dom.asynciterable'];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));

async function readRegularFile(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    assert.ok((await file.stat()).isFile(), 'Input must be a regular file');
    return await file.readFile();
  } finally { await file.close(); }
}

export function parseArgs(args) {
  const options = { out: resolve('.local/package-consumer'), offline: false };
  while (args.length) {
    const flag = args.shift();
    if (flag === '--offline') options.offline = true;
    else if (['--out', '--archives', '--network-guard'].includes(flag)) {
      assert.ok(args[0] && !args[0].startsWith('--'), `Missing value for ${flag}`);
      options[flag === '--network-guard' ? 'networkGuard' : flag.slice(2)] = resolve(args.shift());
    } else throw new Error(`Unknown argument ${flag}`);
  }
  return options;
}

export function runtimeNodeArgs(options, args) {
  return [...(options.networkGuard ? ['--import', options.networkGuard] : []), ...args];
}

export async function readArchives(directory) {
  const entries = (await readdir(directory)).filter((name) => name.endsWith('.tgz')).sort();
  assert.equal(entries.length, names.length, 'The complete bundle must contain exactly six package tarballs');
  const archives = [];
  for (const filename of entries) {
    assert.match(filename, /^cardano-on-evm-[a-z]+-\d+\.\d+\.\d+\.tgz$/, 'Unexpected archive filename');
    const path = join(directory, filename);
    const bytes = await readRegularFile(path);
    // Inspect the same bytes that are hashed, without reopening the input path.
    const stdout = execFileSync('tar', ['-xOz', '-f', '-', 'package/package.json'], { input: bytes, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const meta = JSON.parse(stdout);
    assert.ok(names.includes(meta.name?.split('/')[1]) && meta.name === '@cardano-on-evm/' + meta.name.split('/')[1], 'Unknown package in bundle');
    assert.match(meta.version, /^\d+\.\d+\.\d+$/);
    assert.equal(filename, `cardano-on-evm-${meta.name.split('/')[1]}-${meta.version}.tgz`);
    for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, version] of Object.entries(meta[kind] ?? {})) {
        assert.ok(name !== '@pimlico/alto' && !/^npm:@pimlico\/alto(?:@|$)/.test(version), 'Alto dependencies and aliases are forbidden');
        if (name.startsWith('@cardano-on-evm/')) {
          assert.ok(names.includes(name.split('/')[1]), 'Unexpected project dependency');
          assert.equal(version, meta.version, 'Sibling dependency must use the exact bundle version');
        }
      }
    }
    archives.push({ name: meta.name, version: meta.version, filename, sha256: sha(bytes), integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'), path });
  }
  assert.deepEqual(archives.map((a) => a.name).sort(), names.map((name) => '@cardano-on-evm/' + name).sort());
  assert.equal(new Set(archives.map((a) => a.version)).size, 1, 'Bundle versions differ');
  return archives;
}

export async function checkConsumer(options, execute = run) {
  await mkdir(options.out, { recursive: true });
  const reportPath = join(options.out, 'package-install.json');
  let reportFile;
  try { reportFile = await open(reportPath, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Consumer report exists; use a fresh --out directory');
    throw error;
  }
  const report = { schemaVersion: 1, kind: 'isolated-installed-core-packages', startedAt: new Date().toISOString(), node: process.version, prebuiltArchives: Boolean(options.archives), packages: [], consumerChecks: [], result: {}, allChecksPassed: false };
  let blocker, consumer, consumerOut = options.out;
  try {
    if (options.networkGuard) {
      report.networkGuard = { path: options.networkGuard, sha256: sha(await readRegularFile(options.networkGuard)) };
    }
    const packs = options.archives ?? join(options.out, 'archives');
    if (!options.archives) {
      await mkdir(packs, { recursive: true });
      for (const name of names) {
        await execute('npm', ['pack', '--workspace', `@cardano-on-evm/${name}`, '--pack-destination', packs, '--json', '--ignore-scripts'], { cwd: source, maxBuffer: 1024 * 1024 });
      }
    }
    const archives = await readArchives(packs);
    report.packages = archives.map(({ path, ...item }) => item);
    const combinations = consumerTypeScriptVersions.flatMap(typescript => nodeTypeVersions.map(nodeTypes => ({ typescript, nodeTypes })));
    for (const { typescript, nodeTypes } of combinations) {
      const evidence = `typescript-${typescript}-node-types-${nodeTypes}`;
      consumerOut = join(options.out, evidence);
      await mkdir(consumerOut);
      consumer = await mkdtemp(join(tmpdir(), 'cardano-on-evm-consumer-'));
      report.consumerDirectory = consumer;
      const registryRequests = [];
      blocker = createServer((request, response) => {
        registryRequests.push(request.url);
        response.writeHead(403, { 'content-type': 'application/json' }).end('{"error":"project packages must come from the local bundle"}');
      });
      await new Promise((ready, reject) => { blocker.once('error', reject); blocker.listen(0, '127.0.0.1', ready); });
      const registry = `http://127.0.0.1:${blocker.address().port}/`;
      const localPackages = Object.fromEntries(archives.map((item) => [item.name, 'file:' + item.path]));
      const hostCompiler = typescript === consumerHostTypeScriptVersion ? 'typescript' : 'typescript-host-libs';
      await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'isolated-core-consumer', version: '0.0.0', private: true, type: 'module', dependencies: localPackages, overrides: localPackages,
        devDependencies: { typescript, '@types/node': nodeTypes, ...(hostCompiler === 'typescript' ? {} : { [hostCompiler]: 'npm:typescript@' + consumerHostTypeScriptVersion }) } }));
      // A fresh manifest, fresh lock, and a denying scope registry exercise npm's
      // sibling resolution. Root overrides resolve internal exact-version edges to
      // these same files; without them npm probes registry metadata before dedupe.
      // Third-party dependencies still use the normal registry.
      await writeFile(join(consumer, '.npmrc'), `@cardano-on-evm:registry=${registry}\n`);
      const installed = await execute('npm', ['install', '--ignore-scripts', ...(options.offline ? ['--offline'] : []), '--no-audit', '--no-fund', `--@cardano-on-evm:registry=${registry}`], { cwd: consumer, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
      await writeFile(join(consumerOut, 'npm-install.log'), installed.stdout + installed.stderr);
      assert.deepEqual(registryRequests, [], 'npm tried to fetch a project package from a registry');
      const lock = await json(join(consumer, 'package-lock.json'));
      assert.equal((await json(join(consumer, 'node_modules/@types/node/package.json'))).version, nodeTypes);
      assert.equal((await json(join(consumer, 'node_modules/typescript/package.json'))).version, typescript);
      assert.equal(lock.packages['node_modules/@types/node'].version, nodeTypes);
      assert.equal(lock.packages['node_modules/typescript'].version, typescript);
      const hostPackage = await json(join(consumer, 'node_modules', hostCompiler, 'package.json'));
      assert.equal(hostPackage.name, 'typescript');
      assert.equal(hostPackage.version, consumerHostTypeScriptVersion);
      assert.equal(lock.packages['node_modules/' + hostCompiler].version, consumerHostTypeScriptVersion);
      const hostFiles = consumerHostLibraries.map(name => `node_modules/${hostCompiler}/lib/lib.${name}.d.ts`);
      const hostLibraries = { typescript: consumerHostTypeScriptVersion, files: await Promise.all(hostFiles.map(async path => ({ name: path.split('/').at(-1), sha256: sha(await readRegularFile(join(consumer, path))) }))) };
      if (report.consumerChecks.length) assert.deepEqual(hostLibraries, report.consumerChecks[0].hostLibraries, 'Consumer host library bytes changed between combinations');
      const compiler = join(consumer, 'node_modules/typescript/bin/tsc');
      const compilerVersion = await execute(process.execPath, runtimeNodeArgs(options, [compiler, '--version']), { cwd: consumer, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
      assert.equal(compilerVersion.stdout.trim(), 'Version ' + typescript, 'Compiler execution differs from installed metadata');
      await writeFile(join(consumerOut, 'compiler-version.log'), compilerVersion.stdout + compilerVersion.stderr);
      const nativeName = `@typescript/typescript-${process.platform}-${process.arch}`;
      const nativeCompiler = typescript === '7.0.2' ? await json(join(consumer, 'node_modules', nativeName, 'package.json')) : null;
      if (nativeCompiler) {
        assert.equal(nativeCompiler.version, typescript);
        assert.equal(lock.packages['node_modules/' + nativeName].version, typescript);
      }
      const projectEntries = Object.entries(lock.packages).filter(([path, entry]) => path.includes('node_modules/@cardano-on-evm/') || entry.name?.startsWith('@cardano-on-evm/'));
      assert.equal(projectEntries.length, names.length, 'Unexpected or duplicate project packages were installed');
      assert.ok(!Object.entries(lock.packages).some(([path, entry]) => path.includes('node_modules/@pimlico/alto') || entry.name === '@pimlico/alto'), 'Alto must not be a consumer dependency');
      // Alias keys can hide package names; inspect installed identities as well as
      // the lockfile's paths. Optional packages for other platforms may be absent.
      for (const path of Object.keys(lock.packages).filter((path) => path.startsWith('node_modules/'))) {
        let installed;
        try { installed = await json(join(consumer, path, 'package.json')); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        assert.notEqual(installed.name, '@pimlico/alto', 'An installed alias contains Alto');
        if (installed.name?.startsWith('@cardano-on-evm/')) assert.equal(path, 'node_modules/' + installed.name, 'Project aliases or duplicate project installations are forbidden');
      }
      for (const archive of archives) {
        const relative = 'node_modules/' + archive.name, entry = lock.packages[relative];
        assert.equal(entry.version, archive.version);
        assert.ok(entry.resolved?.startsWith('file:'), 'Project package was not resolved from a local archive');
        assert.equal(entry.integrity, archive.integrity, 'Installed bytes differ from the archive');
        assert.ok(!entry.link && !(await lstat(join(consumer, relative))).isSymbolicLink(), 'A workspace link cannot satisfy a consumer test');
        assert.equal(sha(await readFile(archive.path)), archive.sha256, 'Archive changed during installation');
      }
      await writeFile(join(consumer, 'consumer.mjs'), runtimeFixture);
      await writeFile(join(consumer, 'consumer.ts'), declarationFixture);
      // An explicit project also prevents a caller's ancestor tsconfig from
      // changing standalone-bundle behavior (including with a custom TMPDIR).
      await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({ files: ['consumer.ts', ...hostFiles] }));
      // Load ES2022 from the selected compiler and all original host libraries
      // explicitly from 5.9.2. No declaration is patched, removed or skipped.
      const compiled = await execute(process.execPath, runtimeNodeArgs(options, [compiler, '-p', 'tsconfig.json', '--noEmit', '--strict', '--skipLibCheck', 'false', '--types', 'node', '--lib', 'ES2022', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext']), { cwd: consumer, maxBuffer: 1024 * 1024, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
      await writeFile(join(consumerOut, 'declarations.log'), compiled.stdout + compiled.stderr);
      const executed = await execute(process.execPath, runtimeNodeArgs(options, [join(consumer, 'consumer.mjs')]), { cwd: consumer, maxBuffer: 1024 * 1024, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', CARDANO_ON_EVM_TEST_VERSION: archives[0].version } });
      await writeFile(join(consumerOut, 'esm.log'), executed.stdout + executed.stderr);
      if (options.networkGuard) assert.equal(sha(await readFile(options.networkGuard)), report.networkGuard.sha256, 'The runtime network guard changed during acceptance');
      report.result = { ...JSON.parse(executed.stdout.trim()), installedDeclarationsTypecheck: true, sixLibrariesImported: true, projectRegistryRequests: registryRequests.length, allProjectDependenciesLocal: true, workspaceLinksUsed: false, runtimeNetworkGuarded: Boolean(options.networkGuard) };
      report.lockfileSha256 = sha(await readFile(join(consumer, 'package-lock.json')));
      for (const [file, destination] of [['package.json', 'consumer-package.json'], ['package-lock.json', 'consumer-package-lock.json'], ['tsconfig.json', 'consumer-tsconfig.json']]) {
        const bytes = await readFile(join(consumer, file));
        await writeFile(join(consumerOut, destination), bytes);
        await writeFile(join(options.out, destination), bytes);
      }
      report.consumerChecks.push({ nodeTypes, typescript, compilerVersion: compilerVersion.stdout.trim(), platform: process.platform, arch: process.arch,
        nativeCompiler: nativeCompiler ? { name: nativeName, version: nativeCompiler.version } : null, undiciTypes: lock.packages['node_modules/undici-types'].version,
        lockfileSha256: report.lockfileSha256, evidence, libraries: ['ES2022', ...consumerHostLibraries], hostLibraries, skipLibCheck: false, ...report.result });
      await new Promise((done) => blocker.close(done));
      blocker = undefined;
      await rm(consumer, { recursive: true });
      consumer = undefined;
      report.consumerRemoved = true;
    }
    assert.equal(report.consumerChecks.length, consumerTypeScriptVersions.length * nodeTypeVersions.length, 'Incomplete consumer matrix');
    report.allChecksPassed = true;
  } catch (error) {
    report.failure = error.message;
    if (error.stdout || error.stderr) await writeFile(join(consumerOut, 'failure.log'), (error.stdout ?? '') + (error.stderr ?? ''));
    throw error;
  } finally {
    if (blocker?.listening) await new Promise((done) => blocker.close(done));
    if (consumer) {
      for (const [file, destination] of [['package.json', 'consumer-package.json'], ['package-lock.json', 'consumer-package-lock.json'], ['tsconfig.json', 'consumer-tsconfig.json']]) {
        try {
          const bytes = await readFile(join(consumer, file));
          await writeFile(join(consumerOut, destination), bytes);
          await writeFile(join(options.out, destination), bytes);
        }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      await rm(consumer, { recursive: true });
      report.consumerRemoved = true;
    }
    report.completedAt = new Date().toISOString();
    try { await reportFile.writeFile(JSON.stringify(report, null, 2) + '\n'); }
    finally { await reportFile.close(); }
  }
  console.log(JSON.stringify({ ...report.result, evidence: reportPath }));
  return report;
}

const runtimeFixture = `
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { keccak256, stringToHex, zeroAddress, zeroHash } from 'viem';
import * as walletPackage from '@cardano-on-evm/wallet';
import * as enrollmentPackage from '@cardano-on-evm/enrollment';
import * as sqlitePackage from '@cardano-on-evm/enrollment/sqlite';
import * as sdkPackage from '@cardano-on-evm/sdk';
import * as submissionPackage from '@cardano-on-evm/submission';
import * as protocolPackage from '@cardano-on-evm/protocol';
import * as contractPackage from '@cardano-on-evm/contracts';
const { concatBytes, encodeCbor, toHex, fromHex, cip8SignStructure } = walletPackage;
const { createProfileEnrollmentService, createTableEnrollmentService, MemoryChallengeStore } = enrollmentPackage;
const { SqliteChallengeStore } = sqlitePackage;
const { enrollCardanoAccount, constructOperation, signOperation, operationPayload } = sdkPackage;
const { createPublicBundlerAdapter, createPrivateBundlerAdapter, createDirectAdapter } = submissionPackage;
const { encodeCalls, decodeCalls, encodeTargetAllowlist, encodeSelectorAllowlist } = protocolPackage;
const { PreparedTableValidator, ProfileAccountFactory, TargetAllowlistPolicy, SelectorAllowlistPolicy, manifest } = contractPackage;
const contractNames = ['PreparedTableValidator','PreparedTableFactory','ProfileAccountFactory','ProfilePreparationFactory','RestrictedExecutionHook','TargetAllowlistPolicy','SelectorAllowlistPolicy','Kernel','KernelFactory'];
const protocolNames = ['EXECUTE_USER_OP_SELECTOR','OPERATION_DOMAIN','decodeCalls','decodeRestrictedCalls','deriveProfileIdentity','deriveTableIdentity','encodeCalls','encodeSelectorAllowlist','encodeTargetAllowlist','executeAbi','identityAbi','kernelProxyInitCode','operationFromJson','operationHash','operationPayload','operationToJson','packOperation','profileConfigHash','profileFactoryAbi','tableConfigHash','validatorSignature','wrapRestrictedExecution'];
const exportNames = [
 [walletPackage,['assertAddressKey','cip8SignStructure','concatBytes','CardanoWalletError','connectEternl','connectWallet','connectLace','decodeCbor','encodeCbor','equalBytes','fromHex','parseCardanoAddress','toHex','verifyCip8Signature']],
 [enrollmentPackage,['ENROLLMENT_DOMAIN','MemoryChallengeStore','backendProfileConfigHash','backendTableConfigHash','createEnrollmentHandler','createEnrollmentService','createProfileEnrollmentService','createTableEnrollmentService','deriveBackendProfileIdentity','deriveBackendTableIdentity']],
 [sqlitePackage,['SqliteChallengeStore']],
 [protocolPackage,protocolNames],
 [sdkPackage,[...protocolNames,'accountFactory','accountFromVerifiedKey','accountPreparation','CardanoWalletError','connectEternl','connectWallet','connectLace','constructOperation','enrollCardanoAccount','httpEnrollmentTransport','signOperation','validatorPreparation']],
 [submissionPackage,['RpcError','createDirectAdapter','createPrivateBundlerAdapter','createPublicBundlerAdapter','httpRpc','inclusionFromReceipt','rpcOperation']],
 [contractPackage,[...contractNames,'manifest']],
];
for (const [module,names] of exportNames) assert.deepEqual(Object.keys(module).sort(),names.sort(),'Package exports differ from the reviewed API');
assert.deepEqual(Object.keys(manifest).sort(),['package','version','addressDerivationMode','compiler','contractsSha256','buildSha256','compilerInputIdentity','settings','kernelSettings','artifacts','sources','versions','audited'].sort());
assert.equal(manifest.addressDerivationMode,'portable');
assert.equal(manifest.version,process.env.CARDANO_ON_EVM_TEST_VERSION);
assert.deepEqual(manifest.artifacts.map(item=>item.name).sort(),contractNames.sort());
const contractsRoot=new URL('./node_modules/@cardano-on-evm/contracts/',import.meta.url);
const hash = bytes=>createHash('sha256').update(bytes).digest('hex');
const walk = url=>readdirSync(url,{withFileTypes:true}).flatMap(item=>item.isDirectory()?walk(new URL(item.name+'/',url)).map(file=>item.name+'/'+file):[item.name]).sort();
assert.deepEqual(readdirSync(new URL('artifacts/',contractsRoot)).sort(),contractNames.map(name=>name+'.json').sort());
const sourceFiles=['contracts','vendor'].flatMap(dir=>walk(new URL(dir+'/',contractsRoot)).map(file=>dir+'/'+file)).sort();
assert.deepEqual(sourceFiles,manifest.sources.map(item=>item.file).sort(),'Contract source bundle contains unexpected files');
for(const item of manifest.sources) assert.equal(hash(readFileSync(new URL(item.file,contractsRoot))),item.sha256);
for(const item of manifest.artifacts) {
 const artifact=contractPackage[item.name];
 assert.equal(hash(readFileSync(new URL(item.artifact,contractsRoot))),item.artifactSha256);
 assert.equal(hash(Buffer.from(artifact.bytecode.slice(2),'hex')),item.creationSha256);
 assert.equal(hash(Buffer.from(artifact.deployedBytecode.slice(2),'hex')),item.runtimeTemplateSha256);
 assert.equal(artifact.sourceName,item.source);
}
const seed = new Uint8Array(32).fill(71), key = ed25519.getPublicKey(seed);
const address = concatBytes(Uint8Array.of(0xe0), blake2b(key, {dkLen:28}));
const headers = encodeCbor(new Map([[1,-8],[4,address],['address',address]]));
let signerCalls=0;
const wallet = {name:'GENERATED ISOLATED-CONSUMER TEST DATA',network:async()=>0,addresses:async()=>[toHex(address)],signData:async(a,payload)=>{signerCalls++;return {signature:toHex(encodeCbor([headers,new Map([['hashed',false]]),payload,ed25519.sign(cip8SignStructure(headers,payload),seed)])),key:toHex(encodeCbor(new Map([[1,1],[2,address],[3,-8],[-1,6],[-2,key]])))};}};
for (const id of ['lace','eternl']) {
 const api={getNetworkId:async()=>0,getRewardAddresses:async()=>[toHex(address)],getChangeAddress:async()=>'',getUsedAddresses:async()=>[],signData:async(a,p)=>wallet.signData(a,fromHex(p))};
 const injection={[id]:{name:'GENERATED '+id,apiVersion:'1',enable:async()=>api}};
 const connected=await sdkPackage.connectWallet(injection,id,0);
 assert.equal(connected.walletId,id); assert.equal(connected.apiVersion,'1');
 assert.deepEqual(await connected.addresses('stake'),[toHex(address)]);
 await connected.signData(toHex(address),new Uint8Array(32));
 await assert.rejects(sdkPackage.connectWallet(injection,id==='lace'?'eternl':'lace',0),/not installed/);
 const convenience=await (id==='lace'?walletPackage.connectLace:walletPackage.connectEternl)(injection,0);
 assert.equal(convenience.walletId,id);
}
// Generated infrastructure addresses are test inputs. Creation bytes come only
// from the installed package, and this consumer performs no chain deployment.
const addr=n=>'0x'+n.toString(16).padStart(40,'0');
const baseConfig={chainId:31337,entryPoint:addr(1),kernelImplementation:addr(2),tableFactory:addr(3),validatorCreationCode:PreparedTableValidator.bytecode,namespace:keccak256(stringToHex('cardano-kernel:installed-consumer:test:v1')),index:0n};
const general={...baseConfig,profile:'general',profilePreparationFactory:addr(4),profileFactoryCreationCode:ProfileAccountFactory.bytecode,policy:zeroAddress,policyCodeHash:zeroHash,policyConfig:'0x'};
const configs=[general,
 {...general,profile:'restricted',policy:addr(6),policyCodeHash:keccak256(TargetAllowlistPolicy.deployedBytecode),policyConfig:encodeTargetAllowlist([addr(9)])},
 {...general,profile:'restricted',policy:addr(7),policyCodeHash:keccak256(SelectorAllowlistPolicy.deployedBytecode),policyConfig:encodeSelectorAllowlist([{target:addr(9),selectors:[],allowEmpty:true,allowValue:false}])},
 {...baseConfig,kernelFactory:addr(5)}];
async function enroll(config) {
 const service=('profile' in config?createProfileEnrollmentService:createTableEnrollmentService)({application:'https://example.invalid',cardanoNetwork:0,config,store:new MemoryChallengeStore()});
 return enrollCardanoAccount({wallet,transport:{challenge:a=>service.issue(a),enroll:(id,signed)=>service.enroll(id,signed)},application:'https://example.invalid',cardanoNetwork:0,credential:'stake',cardanoAddress:toHex(address),config});
}
assert.equal(decodeCalls(encodeCalls([{target:addr(9),value:0n,data:'0x'}])).length,1);
assert.ok(PreparedTableValidator.abi.some(item=>item.name==='validateUserOp'));
for(const config of configs) {
 const first=await enroll(config),second=await enroll(config),destination=await enroll({...config,chainId:31338});
 assert.deepEqual(first,second);
 assert.ok(Object.isFrozen(first.config));
 assert.deepEqual(Object.keys(first.config).sort(),Object.keys(config).sort());
 for(const field of ['account','accountSalt','actualAccountSalt','initializeData','factoryData']) assert.equal(first.identity[field],destination.identity[field]);
 assert.notEqual(first.identity.configHash,destination.identity.configHash);
 const op=constructOperation(first,{nonce:0n,deploy:true,calls:[{target:addr(9),value:0n,data:'0x'}],gas:{callGasLimit:250000n,verificationGasLimit:500000n,preVerificationGas:100000n},fees:{maxFeePerGas:50000000n,maxPriorityFeePerGas:2000000n}});
 const signed=await signOperation(first,op,wallet),destinationSigned=await signOperation(destination,op,wallet);
 assert.notEqual(signed.operation.signature,'0x');
 assert.equal(signed.payload,operationPayload(op,config.chainId,config.entryPoint));
 assert.notEqual(signed.payload,destinationSigned.payload);
 const before=signerCalls;
 await assert.rejects(enroll({...config,addressDerivationMode:'portable'}),/Unsupported configuration field/);
 await assert.rejects(signOperation({...first,config:{...first.config,addressDerivationMode:'portable'}},op,wallet),/Unsupported configuration field/);
 assert.equal(signerCalls,before,'Unsupported configuration reached the signer');
}
const sqliteStore = new SqliteChallengeStore(':memory:');
try {
 const service = createProfileEnrollmentService({application:'https://example.invalid',cardanoNetwork:0,config:general,store:sqliteStore,now:()=>1000,ttlMs:100});
 const challenge = await service.issue(toHex(address));
 assert.deepEqual(await sqliteStore.get(challenge.id),challenge);
 assert.equal(await sqliteStore.consume(challenge.id,'00',1000),false);
 const signed = await wallet.signData(toHex(address),fromHex(challenge.payloadHex));
 await service.enroll(challenge.id,signed);
 assert.equal(await sqliteStore.get(challenge.id),undefined);
 await assert.rejects(service.enroll(challenge.id,signed),/unavailable|consumed/);
 const expired = await service.issue(toHex(address));
 assert.equal(await sqliteStore.consume(expired.id,expired.payloadHex,expired.expiresAt),false);
 sqliteStore.prune(expired.expiresAt);
 assert.equal(await sqliteStore.get(expired.id),undefined);
} finally { sqliteStore.close(); }
for (const adapter of [createPublicBundlerAdapter,createPrivateBundlerAdapter,createDirectAdapter]) assert.equal(typeof adapter,'function');
console.log(JSON.stringify({standardNodeEsm:true,installedSdkBackendWalletAndAdapters:true,installedSqliteEnrollmentAndExpiryVerified:true,contractArtifactsMatchGeneratedConfiguration:true,exactPackageExportsVerified:true,exactContractArtifactsVerified:true,contractSourceIntegrityVerified:true,portableCrossChainPrediction:true,chainBoundSigningVerified:true,allProfilesEnrolled:true,deterministicReenrollment:true,generatedAuthorizationVerified:true,unsupportedConfigurationRejectedBeforeSigner:true,privateBundlerInstalled:false,chainTransactionSent:false}));
`;
const declarationFixture = `
import { type CardanoAccount, type ProfileIdentityConfig, type ResolvedAccountConfig, constructOperation, signOperation, enrollCardanoAccount } from '@cardano-on-evm/sdk';
import { connectWallet, connectLace, connectEternl, CardanoWalletError, type CardanoWalletAdapter, type CardanoWalletId, type CardanoWalletInjection, type Cip30Api, type Cip30Provider, type ConnectedCardanoWallet } from '@cardano-on-evm/wallet';
import { connectWallet as sdkConnect, connectEternl as sdkEternl, connectLace as sdkLace, type CardanoWalletInjection as SdkInjection, type CardanoWalletAdapter as SdkAdapter, type Cip30Api as SdkApi, type Cip30Provider as SdkProvider, type CardanoWalletId as SdkWalletId, type ConnectedCardanoWallet as SdkConnected } from '@cardano-on-evm/sdk';
import { createProfileEnrollmentService, createEnrollmentHandler } from '@cardano-on-evm/enrollment';
import { SqliteChallengeStore } from '@cardano-on-evm/enrollment/sqlite';
import { createDirectAdapter, createPublicBundlerAdapter, httpRpc } from '@cardano-on-evm/submission';
import { PreparedTableValidator, ProfileAccountFactory, manifest } from '@cardano-on-evm/contracts';
import { encodeCalls, decodeCalls, type Operation } from '@cardano-on-evm/protocol';
import type { Hex } from 'viem';
declare const config: ProfileIdentityConfig, account: CardanoAccount, wallet: CardanoWalletAdapter;
declare const injection: CardanoWalletInjection, walletId: CardanoWalletId, api: Cip30Api, provider: Cip30Provider;
const selected: Promise<ConnectedCardanoWallet> = connectWallet(injection, walletId, 0);
const eternl: Promise<ConnectedCardanoWallet> = connectEternl(injection, 0);
const lace: Promise<CardanoWalletAdapter> = connectLace(injection, 0);
const sdkInjection: SdkInjection = injection, sdkAdapter: SdkAdapter = wallet, sdkApi: SdkApi = api, sdkProvider: SdkProvider = provider, sdkId: SdkWalletId = walletId;
const fromSdk: Promise<SdkConnected> = sdkConnect(sdkInjection, sdkId, 0);
void [selected, eternl, lace, fromSdk, sdkEternl, sdkLace, sdkAdapter, sdkApi, sdkProvider, CardanoWalletError];
const service = createProfileEnrollmentService({application:'https://example.invalid',cardanoNetwork:0,config,store:new SqliteChallengeStore(':memory:')});
const handler: (r:Request)=>Promise<Response> = createEnrollmentHandler(service);
const enrolled:Promise<CardanoAccount> = enrollCardanoAccount({wallet,transport:{challenge:(address)=>service.issue(address),enroll:(id,signed)=>service.enroll(id,signed)},application:'https://example.invalid',cardanoNetwork:0,credential:'stake',cardanoAddress:account.cardanoAddress,config});
const op = constructOperation(account,{nonce:0n,deploy:true,calls:[{target:'0x0000000000000000000000000000000000000002',value:0n,data:'0x'}],gas:{callGasLimit:250000n,verificationGasLimit:500000n,preVerificationGas:100000n},fees:{maxFeePerGas:50000000n,maxPriorityFeePerGas:2000000n}});
const signed = signOperation(account,op,wallet);
const rpc = httpRpc('https://example.invalid');
const direct = createDirectAdapter({rpc,submitter:'0x0000000000000000000000000000000000000002',sendTransaction:async()=>('0x'+'00'.repeat(32)) as Hex});
const publicAdapter = createPublicBundlerAdapter(rpc);
const typedOperation: Operation = op;
const resolved: Readonly<ResolvedAccountConfig> = account.config;
// @ts-expect-error The resolved account configuration is readonly.
resolved.chainId=31338;
// @ts-expect-error Derivation metadata is not an account configuration option.
const invalidConfig: ProfileIdentityConfig = {...config,addressDerivationMode:'portable'};
void [typedOperation,resolved,encodeCalls,decodeCalls,handler,enrolled,signed,direct,publicAdapter,PreparedTableValidator.bytecode,ProfileAccountFactory.bytecode,manifest,invalidConfig];
`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await checkConsumer(parseArgs(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
