import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const fixture = JSON.parse(readFileSync('.local/reference-browser-fixtures.json', 'utf8'));
const profiles = Object.values(fixture.profiles);
const entryPoints = new Set(profiles.map((profile) => profile.config.entryPoint.toLowerCase()));
assert.equal(entryPoints.size, 1);
const plan = {
  kind: 'reference-read-fixture-plan', chainId: 84532,
  entryPoint: [...entryPoints][0],
  accounts: profiles.map((profile) => profile.enrolled.identity.account),
  factories: profiles.map((profile) => profile.enrolled.identity.profileFactory),
  state: 'Generated fixture accounts are undeployed, unfunded and unprepared.',
};
writeFileSync('.local/reference-rpc-plan.json', JSON.stringify(plan, null, 2) + '\n');
