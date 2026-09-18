import { decodeAbiParameters, decodeFunctionData, formatEther, parseAbi, toHex, keccak256 } from 'viem';
import { connectWallet, CardanoWalletError, fromHex, verifyCip8Signature, type ConnectedCardanoWallet } from '../../packages/wallet/src/index.js';
import { decodeCalls, decodeRestrictedCalls } from '../../packages/protocol/src/index.js';
import { checkLiveRequest, type LiveRequest } from '../../scripts/lib/live-request.js';

import { WalletActions, walletLabel, walletInjection, walletMetadata, selectedWallet, type CurrentRequest } from '../shared/wallet.js';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const select = el<HTMLSelectElement>('request'), connect = el<HTMLButtonElement>('connect'), sign = el<HTMLButtonElement>('sign'), refresh = el<HTMLButtonElement>('refresh'), version = el<HTMLInputElement>('version');
const status = el<HTMLParagraphElement>('status'), selection = el<HTMLSelectElement>('wallet');
const actions = new WalletActions(), label = () => walletLabel(selection.value);
type Item = { request: LiveRequest; signed: boolean; result: { status?: string; transactionHash?: string } | null };
let items: Item[] = []; let wallet: ConnectedCardanoWallet | undefined; let connectedRequest: string | undefined; let reviewValid = false;
const chosen = () => items.find((item) => item.request.id === select.value);
const fail = (error: unknown) => { status.textContent = error instanceof Error ? error.message : 'Wallet request failed'; };
function controls() {
  const item = chosen();
  connect.disabled = actions.busy || !reviewValid || !item || item.signed;
  sign.disabled = actions.busy || !reviewValid || !item || item.signed || !wallet || connectedRequest !== item.request.id || !version.value.trim();
  for (const input of [select, refresh, version, selection]) input.disabled = actions.busy;
  connect.textContent = `Connect ${label()}`; el('version-label').textContent = `Installed ${label()} release`;
  el('wallet-instructions').textContent = `Your ${label()} stake key controls the Base account. Each signature authorizes the exact calls shown below and their fee limit. These operations use Base Sepolia test ETH. They do not move Cardano assets.`;
}
function disconnect() { actions.invalidate(); wallet = undefined; connectedRequest = undefined; controls(); }
const work = (fn: (current: CurrentRequest) => Promise<void>) => actions.run(fn, (error) => {
  if (!(error instanceof CardanoWalletError && error.code === 3 && !error.reconnectRequired)) disconnect();
  fail(error);
}, controls);
function render() {
  wallet = undefined; connectedRequest = undefined; reviewValid = false; const item = chosen(); controls(); el('review').hidden = !item;
  if (!item) { status.textContent = 'No operation is ready for signing yet. Refresh after preparation.'; return; }
  const request = item.request; const operation = checkLiveRequest(request); reviewValid = true; controls();
  el('title').textContent = request.title;
  const context = el('context'); context.replaceChildren();
  const maximumFee = (operation.verificationGasLimit + operation.callGasLimit + operation.preVerificationGas) * operation.maxFeePerGas;
  for (const [label, value] of [
    ['Network', 'Base Sepolia · chain 84532'], ['Submission', request.mode === 'public' ? 'Independent public bundler · Pimlico' : request.mode === 'private' ? 'Self-hosted private bundler · Alto' : 'Direct · normal Base RPC and EntryPoint'],
    ['Account authority', request.profile === 'restricted' ? `Immutable ${request.profileDetails!.name === 'targets' ? 'target' : 'target and function'} allowlist. No administrator or owner opt-out.` : 'General purpose. The Cardano owner can change modules and upgrade the account.'],
    ['Account', operation.sender], ['Action', operation.factory ? 'Create the account, then execute the calls below' : 'Execute on the existing account'],
    ['Account nonce', operation.nonce.toString()], ['Maximum operation gas cost', `${formatEther(maximumFee)} Base Sepolia ETH`],
    ['Signing credential', 'STAKE · Cardano reward key'], ['Cardano reward address (hex)', request.cardanoAddress],
    ['Cardano public key', request.publicKey], ['Root validator', request.validator], ['EntryPoint', request.entryPoint],
  ]) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label!; dd.textContent = value!; context.append(dt, dd); }
  const policy = el('policy'); policy.replaceChildren();
  if (request.profile === 'restricted') {
    const heading = document.createElement('h3'); heading.textContent = 'Permanent account restrictions'; policy.append(heading);
    const details = request.profileDetails!;
    const lines: string[] = [];
    if (details.name === 'targets') {
      const [targets] = decodeAbiParameters([{ type: 'address[]' }], details.policyConfig);
      lines.push(...targets.map((target) => `Allowed target: ${target}. Contract calls and native transfers to this address are allowed.`));
    } else {
      const [rules] = decodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'selectors', type: 'bytes4[]' }, { name: 'allowEmpty', type: 'bool' }, { name: 'allowValue', type: 'bool' }] }], details.policyConfig);
      lines.push(...rules.map((rule) => `Target: ${rule.target}. Allowed functions: ${rule.selectors.map((s) => s === '0x7cf5dab0' ? 'increment(uint256)' : s).join(', ') || 'none'}. Empty data: ${rule.allowEmpty ? 'allowed' : 'blocked'}. Native value: ${rule.allowValue ? 'allowed' : 'blocked'}.`));
    }
    lines.push('Other targets and unsupported execution paths are blocked. This profile cannot remove its restrictions, install modules or upgrade.');
    for (const line of lines) { const p = document.createElement('p'); p.textContent = line; p.style.overflowWrap = 'anywhere'; policy.append(p); }
  }
  const calls = el('calls'); calls.replaceChildren();
  for (const [index, call] of (request.profile === 'restricted' ? decodeRestrictedCalls(operation.callData) : decodeCalls(operation.callData)).entries()) {
    let action = `Call data: ${call.data}`;
    if (call.data === '0x') action = 'Native test ETH transfer';
    else try { const decoded = decodeFunctionData({ abi: parseAbi(['function increment(uint256 amount)']), data: call.data }); action = `increment(${decoded.args[0]})`; } catch { /* Show the exact bytes for unknown calls. */ }
    const div = document.createElement('div'); div.className = 'call'; div.textContent = `Call ${index + 1}: ${action}. Target: ${call.target}. Value: ${formatEther(call.value)} test ETH.`; calls.append(div);
  }
  el('raw').textContent = JSON.stringify({ ...request, calls: undefined }, null, 2);
  status.textContent = item.result ? `Recorded result: ${item.result.status ?? 'available'}${item.result.transactionHash ? ` · ${item.result.transactionHash}` : ''}` : item.signed ? 'Signature verified and saved. The runner has not recorded a result yet.' : `Review the call and fee limit, then connect ${label()} with the wallet used for enrollment.`;
}
async function load(current: CurrentRequest) {
  const previous = select.value; const response = await fetch('/live/requests', { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load prepared operations');
  const data = await response.json(); current();
  for (const item of data.requests) checkLiveRequest(item.request);
  items = data.requests;
  select.replaceChildren(...items.map((item) => new Option(`${item.signed ? 'Signed · ' : ''}${item.request.mode} · ${item.request.title} · nonce ${item.request.operation.nonce}`, item.request.id)));
  select.value = items.some((item) => item.request.id === previous && !item.signed) ? previous : (items.find((item) => !item.signed) ?? items[0])?.request.id ?? '';
  render();
}
select.onchange = () => { disconnect(); try { render(); } catch (error) { reviewValid = false; fail(error); controls(); } };
selection.onchange = () => { disconnect(); version.value = ''; controls(); status.textContent = `Connect ${label()} using a fresh enrollment and prepared operation for this wallet. Wallets may produce different Base account identities.`; };
version.oninput = controls;
function reload() {
  if (actions.busy) return; disconnect(); reviewValid = false; controls(); void work(load);
}
refresh.onclick = reload;
connect.onclick = () => {
  const item = chosen(); if (!item || item.signed || !reviewValid || actions.busy) return;
  disconnect(); const request = item.request;
  void work(async (current) => {
    if (request.walletId !== undefined && request.walletId !== selectedWallet(selection)) throw new Error(`This operation was enrolled with ${walletLabel(request.walletId)}. Enroll again with ${label()} and prepare a new operation.`);
    const connected = await connectWallet(walletInjection(), selectedWallet(selection), request.cardanoNetwork); current();
    const addresses = await connected.addresses(request.credential); current();
    if (!addresses.some((address) => address.toLowerCase() === request.cardanoAddress.toLowerCase())) throw new Error(`This ${label()} wallet does not expose the enrolled stake address. Select the wallet used for the capture.`);
    wallet = connected; connectedRequest = request.id; status.textContent = `${label()} is connected to the enrolled stake address. Review the operation, then sign.`;
  });
};
sign.onclick = () => {
  const item = chosen(); if (!item || !wallet || actions.busy || !reviewValid || item.signed || connectedRequest !== item.request.id || !version.value.trim()) return;
  const request = item.request, connected = wallet;
  const metadata = { ...walletMetadata(connected), walletVersion: version.value.trim(), userAgent: navigator.userAgent };
  void work(async (current) => {
    checkLiveRequest(request);
    const addresses = await connected.addresses(request.credential); current();
    if (!addresses.some((address) => address.toLowerCase() === request.cardanoAddress.toLowerCase())) throw new Error('Wallet account changed. Reconnect before signing.');
    status.textContent = `Approve this Base Sepolia operation authorization in ${label()}.`;
    const signed = await connected.signData(request.cardanoAddress, fromHex(request.payloadHex)); current();
    const verified = verifyCip8Signature(signed, { address: request.cardanoAddress, network: request.cardanoNetwork, payload: fromHex(request.payloadHex) });
    if (toHex(verified.publicKey).toLowerCase() !== request.publicKey.toLowerCase() || keccak256(verified.protectedHeaders) !== request.protectedHeaderHash) throw new Error('Wallet signing key or header profile changed. Enroll again with the selected wallet.');
    const response = await fetch('/live/signature', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: request.id, signed, ...metadata }) });
    const result = await response.json(); current(); if (!response.ok) throw new Error(result.error ?? 'Signature capture failed');
    item.signed = true; status.textContent = `${label()} signature verified and saved. The acceptance runner can now submit this exact operation.`;
  });
};
reload();
