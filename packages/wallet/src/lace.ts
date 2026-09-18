import { connectWallet, type Cip30Provider } from './connector.js';
import type { CardanoNetwork } from './address.js';

// Keep the original module's type exports and call shape for existing users.
export type { Cip30Api, Cip30Provider, CardanoWalletAdapter } from './connector.js';
export function connectLace(injection: { lace?: Cip30Provider }, expectedNetwork: CardanoNetwork) {
  return connectWallet(injection, 'lace', expectedNetwork);
}
