import { decodeAbiParameters, encodeFunctionData, formatEther, parseAbi, parseEther, type Address } from 'viem';
import { connectWallet, enrollCardanoAccount, constructOperation, signOperation, operationHash, operationPayload, operationToJson, accountPreparation, type CardanoAccount, type ProfileIdentityConfig, type Operation, type Call, type EnrollmentTransport } from '../../packages/sdk/src/index.js';
import { CardanoWalletError, type ConnectedCardanoWallet } from '../../packages/wallet/src/index.js';
import { WalletActions, walletLabel, walletInjection, walletMetadata, selectedWallet, type CurrentRequest } from '../shared/wallet.js';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const profile = el<HTMLSelectElement>('profile'), address = el<HTMLSelectElement>('address'), mode = el<HTMLSelectElement>('mode'), action = el<HTMLSelectElement>('action');
const connect = el<HTMLButtonElement>('connect'), enroll = el<HTMLButtonElement>('enroll'), review = el<HTMLButtonElement>('review'), sign = el<HTMLButtonElement>('sign'), poll = el<HTMLButtonElement>('poll');
const acknowledgment = el<HTMLInputElement>('policy-ack'), version = el<HTMLInputElement>('wallet-version');
const status = el('status'), selection = el<HTMLSelectElement>('wallet');
const actions = new WalletActions(), label = () => walletLabel(selection.value);
type Profile = { config: ProfileIdentityConfig; counter: Address; recipient: Address };
type Session = { account: CardanoAccount; sessionId: string; enrollmentFile: string };
let config: { application: string; chainId: number; availableModes: string[]; profiles: Record<string, Profile> };
let wallet: ConnectedCardanoWallet | undefined;
let prepared: { session: Session; mode: string; operation: Operation; calls: readonly Call[] } | undefined;
const sessions = new Map<string, Session>(), last = new Map<string, { sessionId: string; hash: string }>();
const activeSession = () => { const session = sessions.get(profile.value); return wallet && session?.account.cardanoAddress === address.value ? session : undefined; };
const declined = (error: unknown) => error instanceof CardanoWalletError && error.code === 3 && !error.reconnectRequired;
const fail = (error: unknown) => { status.textContent = error instanceof Error ? error.message : 'Request failed'; };
const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
async function post(path: string, body: unknown) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: json(body), signal: AbortSignal.timeout(75000) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`); return data;
}
function controls() {
  for (const input of [profile, mode, action, acknowledgment, version, selection]) input.disabled = actions.busy;
  address.disabled = actions.busy || !wallet || !address.value;
  connect.disabled = actions.busy || !config;
  enroll.disabled = actions.busy || !wallet || !address.value || !version.value.trim() || profile.value !== 'general' && !acknowledgment.checked;
  review.disabled = actions.busy || !activeSession();
  sign.disabled = actions.busy || !wallet || !prepared || prepared.session !== activeSession() || prepared.mode !== mode.value;
  poll.disabled = actions.busy || !last.has(profile.value);
  el('tracking-panel').hidden = !last.has(profile.value);
  connect.textContent = `Connect ${label()}`; el('version-label').textContent = `Installed ${label()} release`;
  el('wallet-instructions').textContent = `Select a test-network software wallet in ${label()}. Enrollment signs an expiring account-configuration challenge with your stake credential.`;
}
const work = (fn: (current: CurrentRequest) => Promise<void>) => actions.run(fn, (error) => {
  if (error instanceof CardanoWalletError && error.reconnectRequired) disconnect();
  else if (!declined(error)) invalidate();
  fail(error);
}, controls);
function invalidate() { actions.invalidate(); prepared = undefined; el('review-panel').hidden = true; controls(); }
function clearEnrollment() {
  sessions.clear(); invalidate(); el('account-panel').hidden = true;
  el('account-state').textContent = ''; el('enrollment-result').textContent = '';
}
function disconnect() { wallet = undefined; address.replaceChildren(); el('address-label').hidden = true; clearEnrollment(); }
function authority() {
  const p = config.profiles[profile.value]!, box = el('authority'); box.replaceChildren();
  const lines: string[] = [];
  if (profile.value === 'general') lines.push('General purpose: the Cardano owner can authorize calls, transfers and batches, and can change modules or upgrade this account.');
  else {
    lines.push('Permanent restrictions: no administrator or owner opt-out. The account cannot remove its restrictions, install modules or upgrade.');
    if (profile.value === 'targets') {
      const [targets] = decodeAbiParameters([{ type: 'address[]' }], p.config.policyConfig);
      lines.push(...targets.map((target) => `Allowed target: ${target}. Calls and native transfers to this address are allowed.`));
    } else {
      const [rules] = decodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'selectors', type: 'bytes4[]' }, { name: 'allowEmpty', type: 'bool' }, { name: 'allowValue', type: 'bool' }] }], p.config.policyConfig);
      lines.push(...rules.map((r) => `Target: ${r.target}. Functions: ${r.selectors.map((s) => s === '0x7cf5dab0' ? 'increment(uint256)' : s).join(', ') || 'none'}. Empty data: ${r.allowEmpty ? 'allowed' : 'blocked'}. Native value: ${r.allowValue ? 'allowed' : 'blocked'}.`));
    }
    lines.push('Other targets, self-calls, delegate calls and unsupported execution paths are blocked.');
  }
  for (const text of lines) { const line = document.createElement('p'); line.textContent = text; box.append(line); }
  acknowledgment.checked = false; el('policy-ack-label').hidden = profile.value === 'general';
}
async function showState(session: Session, current: CurrentRequest) {
  const s = await post('/state', { sessionId: session.sessionId }); current();
  el('account-state').textContent = `Account ${s.address} · ${s.deployed ? 'deployed' : 'predicted, awaiting first operation'} · nonce ${s.nonce}. Native balance ${formatEther(BigInt(s.balance))} test ETH; EntryPoint gas deposit ${formatEther(BigInt(s.deposit))} test ETH.`;
  if (!s.prepared) { status.textContent = `This key needs permissionless preparation and test funding before deployment. Preparation intent: ${json(accountPreparation(session.account))}`; }
  return s;
}
profile.onchange = () => {
  invalidate(); authority(); const session = activeSession(); el('account-panel').hidden = !session; el('receipt').replaceChildren();
  el('enrollment-result').textContent = session ? `Enrolled. Evidence saved at ${session.enrollmentFile}.` : '';
  if (session) void work(async (current) => { await showState(session, current); }); controls();
};
for (const input of [mode, action]) input.onchange = invalidate;
address.onchange = clearEnrollment;
acknowledgment.onchange = controls; version.oninput = controls;
selection.onchange = () => { disconnect(); version.value = ''; controls(); status.textContent = `Connect ${label()} and enroll each profile again. Wallets may produce different Base account identities.`; };
connect.onclick = () => {
  if (actions.busy) return; disconnect();
  void work(async (current) => {
    const connected = await connectWallet(walletInjection(), selectedWallet(selection), 0); current();
    const addresses = await connected.addresses('stake'); current();
    if (!addresses.length) throw new Error(`${label()} exposes no stake address for this wallet. No payment-credential fallback is used.`);
    wallet = connected; address.replaceChildren(...addresses.map((a) => new Option(a, a))); el('address-label').hidden = false;
    status.textContent = `${label()} is connected. Review the selected account profile, then enroll it.`;
  });
};
enroll.onclick = () => {
  if (actions.busy || !wallet || !address.value || !version.value.trim()) return;
  invalidate();
  void work(async (current) => {
    const connected = wallet!;
    if (profile.value !== 'general' && !acknowledgment.checked) throw new Error('Acknowledge the permanent restrictions before enrollment.');
    const name = profile.value, p = config.profiles[name]!, prior = sessions.get(name); let result: any;
    const metadata = { ...walletMetadata(connected), walletVersion: version.value.trim(), userAgent: navigator.userAgent };
    const transport: EnrollmentTransport = {
      challenge: async (a) => { const challenge = await post(`/enrollment/${name}/challenge`, { address: a }); current(); return challenge; },
      enroll: async (id, signed) => { current(); result = await post(`/enrollment/${name}/enroll`, { id, ...signed, ...metadata }); current(); return result; },
    };
    status.textContent = `Approve the account enrollment challenge in ${label()}.`;
    let account: CardanoAccount;
    try { account = await enrollCardanoAccount({ wallet: connected, transport, application: config.application, cardanoAddress: address.value, cardanoNetwork: 0, credential: 'stake', config: p.config }); }
    catch (error) { current(); if (!declined(error)) { disconnect(); fail(error); return; } throw error; }
    current();
    if (!result.sessionId) throw new Error('The reference backend returned no enrollment session.');
    const session = { account, sessionId: result.sessionId, enrollmentFile: result.enrollmentFile }; sessions.set(name, session);
    el('account-panel').hidden = false; el('enrollment-result').textContent = `Enrollment verified and saved at ${session.enrollmentFile}.${prior?.account.publicKey === account.publicKey ? ` Repeated enrollment ${prior.account.identity.account === account.identity.account ? 'returned the same account' : 'changed the address'}.` : ''}`;
    const state = await showState(session, current);
    if (state.prepared) status.textContent = 'SDK and backend address predictions agree. Select an action and submission route.';
  });
};
review.onclick = () => {
  if (actions.busy) return; invalidate();
  void work(async (current) => {
  const session = activeSession(); if (!session) throw new Error('Enroll this profile first.');
  const s = await showState(session, current), p = config.profiles[profile.value]!;
  if (!s.prepared) throw new Error('An operator must submit the permissionless preparation intent before this account can deploy.');
  const increment = (amount: bigint): Call => ({ target: p.counter, value: 0n, data: encodeFunctionData({ abi: parseAbi(['function increment(uint256 amount)']), functionName: 'increment', args: [amount] }) });
  const calls: Call[] = action.value === 'batch' ? [increment(2n), increment(3n)] : action.value === 'transfer' ? [{ target: p.recipient, value: parseEther('0.0000001'), data: '0x' }] : [increment(1n)];
  if (BigInt(s.balance) < calls.reduce((total, call) => total + call.value, 0n)) throw new Error('Fund the account with native test ETH before this transfer.');
  if (BigInt(s.deposit) < parseEther('0.0000425')) throw new Error('Top up this account’s EntryPoint gas deposit before preparing another operation.');
  const operation = constructOperation(session.account, { calls, nonce: BigInt(s.nonce), deploy: !s.deployed, gas: { verificationGasLimit: 500000n, callGasLimit: 250000n, preVerificationGas: 100000n }, fees: { maxFeePerGas: 50000000n, maxPriorityFeePerGas: 2000000n } });
  prepared = { session, mode: mode.value, operation, calls };
  const context = el('context'); context.replaceChildren();
  for (const [label, value] of [['Network', 'Base Sepolia · 84532'], ['Account', operation.sender], ['Submission', mode.selectedOptions[0]!.textContent!], ['Nonce', operation.nonce.toString()], ['Deployment', operation.factory ? 'Create account, then execute' : 'Existing account'], ['Maximum operation gas cost', '0.0000425 test ETH'], ['Cardano signing credential', 'Stake · the enrolled key']]) {
    const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label!; dd.textContent = value!; context.append(dt, dd);
  }
  const callBox = el('calls'); callBox.replaceChildren();
  calls.forEach((call, i) => { const line = document.createElement('div'); line.className = 'call'; line.textContent = `Call ${i + 1}: ${action.value === 'transfer' ? 'native transfer' : `increment by ${action.value === 'batch' ? i + 2 : 1}`}. Target: ${call.target}. Value: ${formatEther(call.value)} test ETH.`; callBox.append(line); });
  el('raw').textContent = json({ operation: operationToJson(operation), payload: operationPayload(operation, config.chainId, session.account.config.entryPoint) });
  el('review-panel').hidden = false; status.textContent = 'Review the calls, route, account and gas cap. Signing will submit this exact operation.';
  });
};
async function checkLast(current: CurrentRequest) {
  const tracked = last.get(profile.value); if (!tracked) throw new Error('No submitted operation in this session.');
  const included = await post('/status', tracked); current(); const receipt = el('receipt'); receipt.replaceChildren();
  receipt.append(`Operation ${included.status}. `);
  if (included.transactionHash) { const link = document.createElement('a'); link.href = `https://sepolia.basescan.org/tx/${included.transactionHash}`; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'View Base Sepolia transaction'; receipt.append(link); }
  status.textContent = included.status === 'pending' ? 'The operation is pending. Check again shortly; the saved authorization keeps the same nonce and hash.' : included.status === 'included' ? 'Operation included successfully; receipt independently verified through Base RPC.' : 'The operation was included but execution reverted. Its gas was charged and nonce consumed.';
  const session = activeSession(); if (session) await showState(session, current);
}
poll.onclick = () => void work(checkLast);
sign.onclick = () => void work(async (current) => {
  const snapshot = prepared, connected = wallet, name = profile.value;
  if (!snapshot || !connected || snapshot.session !== activeSession() || snapshot.mode !== mode.value) throw new Error('Prepare and review an operation first.');
  status.textContent = `Approve this operation authorization in ${label()}.`;
  let signed: Awaited<ReturnType<typeof signOperation>>;
  try { signed = await signOperation(snapshot.session.account, snapshot.operation, connected); }
  catch (error) { current(); if (!declined(error)) { disconnect(); fail(error); return; } throw error; }
  current();
  const hash = operationHash(signed.operation, config.chainId, snapshot.session.account.config.entryPoint);
  const tracked = { sessionId: snapshot.session.sessionId, hash };
  // Once submission starts, retain its hash even if the UI selection changes.
  last.set(name, tracked); prepared = undefined; el('review-panel').hidden = true;
  status.textContent = 'Signature verified. Submitting the authorized operation…';
  await post('/submit', { ...tracked, mode: snapshot.mode, operation: operationToJson(signed.operation), authorization: signed.authorization, ...walletMetadata(connected), walletVersion: version.value.trim(), userAgent: navigator.userAgent }); current();
  await checkLast(current);
});
async function start() {
  const response = await fetch('/config'); if (!response.ok) throw new Error('Reference configuration is unavailable.');
  config = await response.json();
  for (const p of Object.values(config.profiles)) p.config.index = BigInt(p.config.index);
  mode.replaceChildren(...config.availableModes.map((value) => new Option(value === 'public' ? 'Public · Pimlico' : value === 'private' ? 'Private · self-hosted Alto' : 'Direct · ordinary Base RPC', value)));
  authority(); controls(); status.textContent = `Choose an account profile and connect ${label()}.`;
}
void start().catch(fail);
