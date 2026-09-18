import test from 'node:test';
import assert from 'node:assert/strict';
import { bech32 } from '@scure/base';
import { ed25519 } from '@noble/curves/ed25519.js';
import { connectWallet, connectLace, connectEternl, CardanoWalletError, toHex, fromHex, encodeCbor, decodeCbor, verifyCip8Signature, type Cbor, type Cip30Api, type Cip30Provider, type CardanoWalletId, type CardanoWalletInjection, type DataSignature } from '../packages/wallet/src/index.js';
import { connectWallet as sdkConnect, connectEternl as sdkEternl, connectLace as sdkLace, accountFromVerifiedKey, constructOperation, signOperation, type TableIdentityConfig } from '../packages/sdk/src/index.js';
import { connectLace as legacyLace, type CardanoWalletAdapter } from '../packages/wallet/src/lace.js';
import { fixtureAddress, fixtureSeed, signFixture } from './fixtures.js';

const stake = toHex(fixtureAddress(14)), payment = toHex(fixtureAddress(0)), enterprise = toHex(fixtureAddress(6));
const payload = new Uint8Array(32).fill(42);
function fixture(id: CardanoWalletId) {
  const state = { network: 0, rewards: [stake], change: payment, used: [payment, enterprise], enables: 0, signs: 0, enableError: undefined as unknown, apiError: undefined as unknown, signError: undefined as unknown };
  const api: Cip30Api = {
    getNetworkId: async () => { if (state.apiError) throw state.apiError; return state.network; },
    getRewardAddresses: async () => state.rewards,
    getChangeAddress: async () => state.change,
    getUsedAddresses: async () => state.used,
    signData: async (address, data) => { ++state.signs; if (state.signError) throw state.signError; return signFixture(fromHex(data), fromHex(address), undefined, true); },
  };
  const provider: Cip30Provider = { name: `Generated ${id} provider`, apiVersion: '1', enable: async () => { state.enables++; if (state.enableError) throw state.enableError; return api; } };
  return { state, api, provider, injection: { [id]: provider } as CardanoWalletInjection };
}

for (const id of ['lace', 'eternl'] as const) {
  test(`${id}: selected provider only, missing provider and original APIs`, async () => {
    const f = fixture(id), other = id === 'lace' ? 'eternl' : 'lace', unused = fixture(other);
    await assert.rejects(connectWallet({}, id, 0), /not installed/);
    await assert.rejects(connectWallet(unused.injection, id, 0), /not installed/);
    assert.equal(unused.state.enables, 0);
    const wallet: CardanoWalletAdapter = await connectWallet({ ...f.injection, ...unused.injection }, id, 0);
    assert.equal(wallet.name, f.provider.name); assert.equal(f.state.enables, 1); assert.equal(unused.state.enables, 0);
    const convenient = await (id === 'lace' ? connectLace(f.injection, 0) : connectEternl(f.injection, 0));
    assert.equal(convenient.walletId, id); assert.equal(convenient.apiVersion, '1');
    assert.equal(sdkConnect, connectWallet); assert.equal(sdkEternl, connectEternl); assert.equal(sdkLace, legacyLace);
  });

  test(`${id}: rejected connection and CIP-30 errors retain cause and recovery guidance`, async () => {
    for (const cause of [{ code: -1, info: 'bad request' }, { code: -2, info: 'internal failure' }, { code: -3, info: 'disconnected' }, { code: -4, info: 'account changed' }, new Error('extension refused'), 'extension unavailable']) {
      const f = fixture(id); f.state.enableError = cause;
      await assert.rejects(connectWallet(f.injection, id, 0), (error: unknown) => {
        assert.ok(error instanceof CardanoWalletError); assert.equal(error.cause, cause); assert.equal(error.walletId, id);
        assert.match(error.message, new RegExp(id, 'i')); assert.ok(!error.message.includes('[object Object]')); return true;
      });
    }
    for (const code of [-3, -4]) {
      const f = fixture(id), wallet = await connectWallet(f.injection, id, 0), cause = { code, info: 'needs reconnect' };
      f.state.apiError = cause;
      await assert.rejects(wallet.addresses('stake'), (e: unknown) => e instanceof CardanoWalletError && e.reconnectRequired && e.cause === cause);
      f.state.apiError = undefined;
      await assert.rejects(wallet.signData(stake, payload), /Reconnect/); assert.equal(f.state.signs, 0);
      const reconnected = await connectWallet(f.injection, id, 0); await reconnected.signData(stake, payload);
    }
    const f = fixture(id), wallet = await connectWallet(f.injection, id, 0);
    for (const code of [1, 2, 3]) {
      const cause = { code, info: 'data-sign error' }; f.state.signError = cause;
      await assert.rejects(wallet.signData(stake, payload), (e: unknown) => e instanceof CardanoWalletError && e.code === code && !e.reconnectRequired && e.cause === cause);
    }
    f.state.signError = undefined; await wallet.signData(stake, payload);
    assert.equal(f.state.enables, 1, 'Declined signing does not reconnect automatically');
  });

  test(`${id}: normalizes/deduplicates explicit payment and stake addresses; empty rewards stay empty`, async () => {
    const f = fixture(id), wallet = await connectWallet(f.injection, id, 0);
    f.state.change = bech32.encode('addr_test', bech32.toWords(fromHex(payment)), 120);
    f.state.used = [payment.toUpperCase(), `0x${payment}`, enterprise];
    f.state.rewards = [stake.toUpperCase(), bech32.encode('stake_test', bech32.toWords(fromHex(stake)), 120)];
    assert.deepEqual(await wallet.addresses('payment'), [payment, enterprise]);
    assert.deepEqual(await wallet.addresses('stake'), [stake]);
    f.state.rewards = []; assert.deepEqual(await wallet.addresses('stake'), []);
    await assert.rejects(wallet.signData(stake, payload), /unavailable/); assert.equal(f.state.signs, 0);
  });

  test(`${id}: rejects credential/network mismatches and unsupported addresses`, async () => {
    const f = fixture(id); f.state.network = 1; await assert.rejects(connectWallet(f.injection, id, 0), /network/);
    for (const [credential, bad] of [['stake', payment], ['payment', stake], ['stake', toHex(fixtureAddress(14, 1))], ['stake', 'f0'+'07'.repeat(28)], ['stake', 'not-hex']] as const) {
      const f = fixture(id), wallet = await connectWallet(f.injection, id, 0);
      if (credential === 'stake') f.state.rewards = [bad]; else f.state.change = bad;
      await assert.rejects(wallet.addresses(credential)); assert.equal(f.state.signs, 0);
    }
  });

  test(`${id}: detects account and network changes before/after signing and snapshots payload`, async () => {
    for (const change of ['before', 'network', 'address'] as const) {
      const f = fixture(id), wallet = await connectWallet(f.injection, id, 0), original = f.api.signData;
      if (change === 'before') f.state.rewards = [];
      else f.api.signData = async (address, data) => { const signed = await original(address, data); if (change === 'network') f.state.network = 1; else f.state.rewards = []; return signed; };
      await assert.rejects(wallet.signData(stake, payload), /changed|unavailable/);
      assert.equal(f.state.signs, change === 'before' ? 0 : 1);
    }
    const f = fixture(id), wallet = await connectWallet(f.injection, id, 0), mutable = payload.slice();
    const signing = wallet.signData(stake, mutable); mutable.fill(7);
    verifyCip8Signature(await signing, { address: stake, network: 0, payload });
  });

  test(`${id}: verifies exact payload, address, key, header and COSE encoding`, async () => {
    const badSeed = new Uint8Array(32).fill(9);
    const differentKeyAddress = fixtureAddress(14, 0, ed25519.getPublicKey(badSeed));
    const valid = signFixture(payload, fixtureAddress(14), fixtureSeed, true);
    const altered = (edit: (array: Cbor[]) => void): DataSignature => { const array = decodeCbor(fromHex(valid.signature)) as Cbor[]; edit(array); return { ...valid, signature: toHex(encodeCbor(array)) }; };
    const corruptions = [
      { ...valid, signature: 'not-hex' }, { ...valid, signature: '9fff' }, { ...valid, key: '00' },
      signFixture(new Uint8Array(32), fixtureAddress(14), undefined, true),
      signFixture(payload, differentKeyAddress, badSeed, true),
      signFixture(payload, fixtureAddress(14), badSeed, true),
      altered((a) => { a[1] = new Map([['hashed', true]]); }),
      altered((a) => { const headers = decodeCbor(a[0] as Uint8Array) as Map<number | string, Cbor>; headers.set(1, -7); a[0] = encodeCbor(headers); }),
      altered((a) => { (a[3] as Uint8Array)[0]! ^= 1; }),
    ];
    for (const signed of corruptions) {
      const f = fixture(id), wallet = await connectWallet(f.injection, id, 0); f.api.signData = async () => signed;
      await assert.rejects(wallet.signData(stake, payload));
    }
    for (const claimed of [stake, payment, enterprise]) {
      const f = fixture(id), wallet = await connectWallet(f.injection, id, 0);
      verifyCip8Signature(await wallet.signData(claimed, payload), { address: claimed, network: 0, payload });
    }
  });

  test(`${id}: SDK rejects a changed protected-header format for an enrolled account`, async () => {
    const f = fixture(id), wallet = await connectWallet(f.injection, id, 0);
    const config: TableIdentityConfig = { chainId: 84532, entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032', kernelImplementation: '0x0000000000000000000000000000000000000102', kernelFactory: '0x0000000000000000000000000000000000000103', tableFactory: '0x0000000000000000000000000000000000000104', validatorCreationCode: '0x60006000f3', namespace: `0x${'01'.repeat(32)}`, index: 0n };
    const account = accountFromVerifiedKey(verifyCip8Signature(await wallet.signData(stake, payload), { address: stake, network: 0, payload }), config);
    const operation = constructOperation(account, { calls: [{ target: config.entryPoint, value: 0n, data: '0x' }], nonce: 0n, deploy: true, gas: { callGasLimit: 250000n, verificationGasLimit: 500000n, preVerificationGas: 100000n }, fees: { maxFeePerGas: 50000000n, maxPriorityFeePerGas: 2000000n } });
    await signOperation(account, operation, wallet);
    f.api.signData = async (address, data) => signFixture(fromHex(data), fromHex(address));
    await assert.rejects(signOperation(account, operation, wallet), /header profile changed/);
  });
}
