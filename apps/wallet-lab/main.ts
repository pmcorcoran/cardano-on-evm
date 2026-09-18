import { connectWallet, CardanoWalletError, fromHex, parseCardanoAddress, type ConnectedCardanoWallet, type CardanoNetwork } from '../../packages/wallet/src/index.js';
import { WalletActions, walletLabel, walletInjection, walletMetadata, selectedWallet, type CurrentRequest } from '../shared/wallet.js';
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const connect = element<HTMLButtonElement>('connect'), capture = element<HTMLButtonElement>('capture');
const address = element<HTMLSelectElement>('address'), network = element<HTMLSelectElement>('network'), selection = element<HTMLSelectElement>('wallet');
const credential = element<HTMLSelectElement>('credential'), version = element<HTMLInputElement>('version');
const status = element<HTMLParagraphElement>('status'), details = element<HTMLPreElement>('details');
let wallet: ConnectedCardanoWallet | undefined;
const actions = new WalletActions(), label = () => walletLabel(selection.value);
function controls() {
  for (const input of [selection, network, credential, version, connect]) input.disabled = actions.busy;
  address.disabled = actions.busy || !wallet || !address.value;
  capture.disabled = actions.busy || !wallet || !address.value || !version.value.trim();
  connect.textContent = `Connect ${label()}`; element('version-label').textContent = `Installed ${label()} release`;
}
function clearAddresses() { actions.invalidate(); address.replaceChildren(); details.textContent = 'Verified public-key and signing details will appear here.'; }
function disconnect() { wallet = undefined; clearAddresses(); controls(); }
function fail(error: unknown) {
  // A declined prompt leaves the connection available for a deliberate retry.
  if (!(error instanceof CardanoWalletError && error.code === 3 && !error.reconnectRequired)) disconnect();
  status.textContent = error instanceof Error ? error.message : `${label()} request failed`;
}
const work = (fn: (current: CurrentRequest) => Promise<void>) => actions.run(fn, fail, controls);
async function post(path: string, body: unknown) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error ?? 'Request failed'); return result;
}
async function refresh(current: CurrentRequest) {
  const connected = wallet; if (!connected) return;
  const selectedCredential = credential.value as 'payment' | 'stake', selectedNetwork = Number(network.value) as CardanoNetwork;
  const addresses = await connected.addresses(selectedCredential); current();
  if (addresses.some((value) => parseCardanoAddress(value, selectedNetwork).credential !== selectedCredential)) throw new Error('Wallet returned an address for a different credential. Signing is disabled.');
  address.replaceChildren(...addresses.map((value) => new Option(value, value)));
  status.textContent = addresses.length ? `Connected to ${label()}. Signing credential: ${selectedCredential === 'stake' ? 'STAKE — reward address (type 14)' : 'PAYMENT'}. Choose an address to sign.` : `${label()} exposes no supported addresses for this credential. Choose another credential explicitly.`;
}
connect.onclick = () => {
  if (actions.busy) return; disconnect();
  void work(async (current) => {
    const id = selectedWallet(selection), expectedNetwork = Number(network.value) as CardanoNetwork;
    const connected = await connectWallet(walletInjection(), id, expectedNetwork); current();
    wallet = connected; await refresh(current);
  });
};
selection.onchange = () => { disconnect(); version.value = ''; controls(); status.textContent = `Connect ${label()} and enter its installed release. Fresh enrollment is required for this wallet.`; };
network.onchange = () => { disconnect(); status.textContent = `Reconnect ${label()} for the selected network.`; };
credential.onchange = () => { clearAddresses(); controls(); void work(refresh); };
version.oninput = controls;
address.onchange = controls;
capture.onclick = () => {
  if (!wallet || !address.value || !version.value.trim() || actions.busy) return;
  const connected = wallet, selectedAddress = address.value, selectedNetwork = Number(network.value) as CardanoNetwork, selectedCredential = credential.value;
  const metadata = { ...walletMetadata(connected), walletRelease: version.value.trim(), userAgent: navigator.userAgent };
  void work(async (current) => {
    if (parseCardanoAddress(selectedAddress, selectedNetwork).credential !== selectedCredential) throw new Error(`Selected address does not match the signing credential. Reconnect ${label()}.`);
    const challenge = await post('/lab/challenge', { address: selectedAddress, network: selectedNetwork, credential: selectedCredential }); current();
    status.textContent = `Approve the enrollment challenge in ${label()}.`;
    const enrollment = await connected.signData(selectedAddress, fromHex(challenge.payloadHex)); current();
    status.textContent = `Approve the operation format probe in ${label()}.`;
    const operation = await connected.signData(selectedAddress, fromHex(challenge.operation.payloadHex)); current();
    const result = await post('/lab/capture', { id: challenge.id, network: selectedNetwork, credential: selectedCredential, ...metadata, enrollment, operation }); current();
    details.textContent = JSON.stringify(result, null, 2);
    status.textContent = `Both ${label()} ${selectedCredential} signatures verified. Evidence saved on this machine.`;
  });
};
controls();
