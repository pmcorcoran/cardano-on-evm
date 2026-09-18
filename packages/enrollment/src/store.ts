export interface ChallengeRecord {
  id: string;
  application: string;
  cardanoAddress: string;
  cardanoNetwork: 0 | 1;
  baseChainId: number;
  configHash: string;
  issuedAt: number;
  expiresAt: number;
  payloadHex: string;
}

/** All implementations MUST implement consume as an atomic compare-and-delete
 * against payloadHex AND expiry. Successful verification alone must not delete
 * a challenge. No return of a successful enrollment before consume succeeds. */
export interface ChallengeStore {
  put(record: ChallengeRecord): Promise<void>;
  get(id: string): Promise<ChallengeRecord | undefined>;
  consume(id: string, payloadHex: string, now: number): Promise<boolean>;
}

/** Single-process reference store. Use the SQLite adapter or a shared database
 * implementing the same atomic contract for multiple workers/replicas. */
export class MemoryChallengeStore implements ChallengeStore {
  readonly #records = new Map<string, ChallengeRecord>();
  async put(record: ChallengeRecord): Promise<void> {
    if (this.#records.has(record.id)) throw new Error('Challenge identifier collision');
    this.#records.set(record.id, structuredClone(record));
  }
  async get(id: string): Promise<ChallengeRecord | undefined> {
    const record = this.#records.get(id); return record && structuredClone(record);
  }
  async consume(id: string, payloadHex: string, now: number): Promise<boolean> {
    // No await between comparison and deletion: atomic within this JS process.
    const record = this.#records.get(id);
    if (!record || record.payloadHex !== payloadHex || now >= record.expiresAt) return false;
    this.#records.delete(id); return true;
  }
  prune(now: number): void {
    for (const [id, record] of this.#records) if (now >= record.expiresAt) this.#records.delete(id);
  }
}
