import { type CardanoWalletId, type CardanoWalletInjection, type ConnectedCardanoWallet } from '../../packages/wallet/src/index.js';

export const walletLabel = (id: string) => id === 'eternl' ? 'Eternl' : 'Lace';
export const walletInjection = () => (window as unknown as { cardano?: CardanoWalletInjection }).cardano ?? {};
export const selectedWallet = (select: HTMLSelectElement): CardanoWalletId => {
  if (select.value !== 'lace' && select.value !== 'eternl') throw new Error('Choose Lace or Eternl');
  return select.value;
};
export const walletMetadata = (wallet: ConnectedCardanoWallet) => ({ walletId: wallet.walletId, walletName: wallet.name, walletApiVersion: wallet.apiVersion });
export type CurrentRequest = () => void;

/** Serialize prompts and discard results from any invalidated selection/review. */
export class WalletActions {
  busy = false;
  private revision = 0;
  invalidate() { ++this.revision; }
  async run(work: (current: CurrentRequest) => Promise<void>, fail: (error: unknown) => void, controls: () => void) {
    if (this.busy) return;
    this.busy = true; const revision = this.revision; controls();
    const current = () => { if (revision !== this.revision) throw new Error('Wallet selection changed; stale request ignored'); };
    try { await work(current); }
    catch (error) { if (revision === this.revision) fail(error); }
    finally { this.busy = false; controls(); }
  }
}
