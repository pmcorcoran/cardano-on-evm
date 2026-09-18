import { writeFileSync, mkdirSync } from 'node:fs';
import { fixtureAddress, fixturePublicKey, signFixture } from '../tests/fixtures.js';
import { toHex } from '../packages/wallet/src/index.js';

const payload = new TextEncoder().encode('cardano-kernel:generated-enrollment-fixture:v1');
const records = ([0, 2, 6, 14] as const).map((type) => {
  const address = fixtureAddress(type);
  return { type, network: 0, credential: type === 14 ? 'stake' : 'payment', address: toHex(address), payload: toHex(payload), publicKey: toHex(fixturePublicKey), ...signFixture(payload, address) };
});
mkdirSync('fixtures', { recursive: true });
writeFileSync('fixtures/generated-cip8.json', JSON.stringify({ provenance: 'Generated with a public test seed by tests/fixtures.ts. These are NOT Lace or real-wallet signatures.', records }, null, 2) + '\n');
