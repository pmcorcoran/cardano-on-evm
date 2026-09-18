import { readProfileManifest } from '../lib/identity-manifest.js';
import './errors.js';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { encodeFunctionData, parseEther } from 'viem';
import { entryPoint07Abi } from 'viem/account-abstraction';
import { liveContext, entryPoint, json, assertLiveConfig, verifyPreparedProfile } from '../lib/live-context.js';

const { values } = parseArgs({ options: { manifest: { type: 'string' }, infrastructure: { type: 'string' }, journal: { type: 'string' }, 'key-file': { type: 'string' }, 'key-variable': { type: 'string', default: 'SUBMITTER_PRIVATE_KEY' }, send: { type: 'boolean', default: false } } });
assert.ok(values.manifest && values.infrastructure && values.journal && values['key-file'], '--manifest, --infrastructure, --journal and --key-file are required');
const setup = readProfileManifest(values.manifest);
assert.equal(setup.chainId, 84532); assert.equal(setup.infrastructureVerified, true); assert.ok(!setup.testData);
const context = await liveContext(values['key-file'], values['key-variable']!, { manifest: values.infrastructure, journal: values.journal, independentSubmitter: true });
try {
  const { client, transact } = context;
  for (const name of ['targets', 'selectors']) {
    const profile = setup.profiles[name];
    assert.ok(profile?.identity && profile.sdkBackendAndLiveFactoryAgree, 'A prepared profile identity is required');
    assertLiveConfig(profile.config, context);
    await verifyPreparedProfile(client, profile.config, profile.identity);
  }
  for (const name of ['targets', 'selectors']) {
    const account = setup.profiles[name].identity.account;
    // One journalled top-up per account; total test-fund outlay is 0.00005 ETH.
    await transact(`policy-coverage-top-up-v1-${account.toLowerCase()}`, { to: entryPoint, data: encodeFunctionData({ abi: entryPoint07Abi, functionName: 'depositTo', args: [account] }), value: parseEther('0.000025') }, values.send);
    const deposit = await client.readContract({ address: entryPoint, abi: entryPoint07Abi, functionName: 'balanceOf', args: [account] });
    if (values.send) assert.ok(deposit >= parseEther('0.000085'));
    console.log(json({ profile: name, account, deposit }));
  }
} finally { context.release(); }
