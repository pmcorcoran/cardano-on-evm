import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromHex, toHex, verifyCip8Signature } from '../packages/wallet/src/index.js';
const corpus = JSON.parse(readFileSync('fixtures/wallet-signatures.json', 'utf8'));
test('frozen generated payment/stake, key-id, payload and malformed CIP-8 controls', () => {
  assert.equal(corpus.testData, true);
  assert.equal(corpus.realWallet, false);
  const coverage = new Set<string>();
  let accepted = 0, rejected = 0;
  for (const vector of corpus.records) {
    const verify = () => verifyCip8Signature(vector.signed, { address: vector.address, network: vector.network, payload: fromHex(vector.payload) });
    if (vector.accepted) {
      const actual = verify();
      assert.equal(toHex(actual.publicKey), vector.publicKey);
      assert.equal(actual.address.credential, vector.credential);
      coverage.add(`${vector.type}/${vector.includeKid}/${vector.purpose}`); accepted++;
    } else {
      assert.throws(verify, new RegExp(vector.error)); rejected++;
    }
  }
  for (const type of [0, 2, 6, 14]) for (const kid of [false, true]) for (const purpose of ['enrollment', 'operation']) assert.ok(coverage.has(`${type}/${kid}/${purpose}`));
  assert.equal(accepted, 16); assert.equal(rejected, 24);
});
