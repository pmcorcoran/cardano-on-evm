import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadFixture } from '../../scripts/ci/local-rpc.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const account = '0x' + '11'.repeat(20), factory = '0x' + '22'.repeat(20), entryPoint = '0x' + '33'.repeat(20);
const plan = { kind: 'reference-read-fixture-plan', chainId: 84532, entryPoint, accounts: [account], factories: [factory] };
const request = (method, params = []) => ({ jsonrpc: '2.0', id: 1, method, params });
test('reference fixture accepts only exact startup and state reads', () => {
  const { respond } = createReadFixture(plan);
  assert.equal(respond(request('eth_chainId')).result, '0x14a34');
  for (const target of [account, factory]) assert.equal(respond(request('eth_getCode', [target, 'latest'])).result, '0x');
  assert.equal(respond(request('eth_getBalance', [account, 'latest'])).result, '0x0');
  for (const data of ['0x70a08231' + account.slice(2).padStart(64, '0'), '0x35567e1a' + account.slice(2).padStart(64, '0') + '0'.repeat(64)]) assert.equal(respond(request('eth_call', [{ to: entryPoint, data }, 'latest'])).result, '0x' + '0'.repeat(64));
});
test('transactions, unrelated reads, altered calls and malformed requests are rejected', () => {
  const { respond } = createReadFixture(plan);
  const forbidden = [request('eth_sendTransaction', [{}]), request('eth_sendRawTransaction', ['0x01']), request('eth_sendUserOperation', [{}, entryPoint]), request('anvil_setBalance', [account, '0x1']), request('eth_getBlockByNumber', ['latest', false]), request('eth_chainId', [1]), request('eth_getCode', [entryPoint, 'latest']), request('eth_getBalance', [factory, 'latest']), request('eth_getCode', [account, 'pending']), request('eth_call', [{ to: entryPoint, data: '0x70a08231' + account.slice(2).padStart(64, '0'), value: '0x1' }, 'latest']), request('eth_call', [{ to: entryPoint, data: '0xdeadbeef' }, 'latest']), [request('eth_chainId')], {}, { ...request('eth_chainId'), extra: true }];
  for (const body of forbidden) { const result = respond(body); assert.ok(result.error, JSON.stringify(body)); assert.equal(result.result, undefined); }
});
test('loopback HTTP fixture refuses wrong routes, verbs, hosts and malformed JSON', async () => {
  const { server } = createReadFixture(plan);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(url)).status, 403);
    const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request('eth_chainId')) };
    assert.equal((await (await fetch(url, options)).json()).result, '0x14a34');
    for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sendUserOperation', 'eth_getBlockByNumber']) {
      const denied = await (await fetch(url, { ...options, body: JSON.stringify(request(method, [])) })).json();
      assert.equal(denied.error?.code, -32601);
      assert.equal(denied.result, undefined);
    }
    assert.equal((await fetch(url + '/other', options)).status, 403);
    const wrongHost = await new Promise((resolve, reject) => {
      const req = httpRequest(url, { method: 'POST', headers: { ...options.headers, host: 'untrusted.invalid' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.once('error', reject); req.end(options.body);
    });
    assert.equal(wrongHost, 403);
    assert.equal((await fetch(url, { ...options, body: 'invalid' })).status, 400);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
test('local network preload makes public HTTP, HTTPS and raw TCP unavailable', () => {
  const guard = fileURLToPath(new URL('../../scripts/ci/local-network-guard.mjs', import.meta.url));
  const script = `import assert from 'node:assert/strict'; import net from 'node:net';
    for (const url of ['https://sepolia.base.org', 'http://198.51.100.1', 'https://public.pimlico.io']) await assert.rejects(fetch(url), (error) => error.cause?.code === 'LOCAL_NETWORK_DENIED');
    assert.throws(() => net.connect({host:'1.1.1.1',port:443}), {code:'LOCAL_NETWORK_DENIED'}); console.log('public RPC unavailable');`;
  const result = spawnSync(process.execPath, ['--import', guard, '--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /public RPC unavailable/);
});
test('the pinned viem client can perform the exact reference startup and state reads', async () => {
  const { createPublicClient, http, parseAbi } = await import('viem');
  const { server, requests } = createReadFixture(plan);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = createPublicClient({ transport: http(`http://127.0.0.1:${server.address().port}`) });
  try {
    assert.equal(await client.getChainId(), 84532);
    await client.getCode({ address: account });
    await client.getCode({ address: factory });
    assert.equal(await client.getBalance({ address: account }), 0n);
    const abi = parseAbi(['function getNonce(address,uint192) view returns (uint256)', 'function balanceOf(address) view returns (uint256)']);
    assert.equal(await client.readContract({ address: entryPoint, abi, functionName: 'getNonce', args: [account, 0n] }), 0n);
    assert.equal(await client.readContract({ address: entryPoint, abi, functionName: 'balanceOf', args: [account] }), 0n);
    assert.equal(requests.length, 6);
    assert.ok(requests.every((request) => request.accepted));
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
test('local network denial survives the private worker minimal environment fork', () => {
  const guard = fileURLToPath(new URL('../../scripts/ci/local-network-guard.mjs', import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), 'kernel-guard-fork-'));
  const worker = join(directory, 'worker.mjs');
  writeFileSync(worker, `import assert from 'node:assert/strict'; await assert.rejects(fetch('https://sepolia.base.org'), e => e.cause?.code === 'LOCAL_NETWORK_DENIED'); process.send({denied:true});`);
  try {
    const script = `import { fork } from 'node:child_process'; import assert from 'node:assert/strict';
      const child = fork(process.argv[1], [], {execArgv:[],env:{PATH:process.env.PATH}});
      let denied=false; child.on('message', message=>{denied=message.denied}); child.on('exit', code=>{assert.equal(code,0); assert.equal(denied,true)});`;
    const result = spawnSync(process.execPath, ['--import', guard, '--input-type=module', '-e', script, worker], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(directory, { recursive: true }); }
});
