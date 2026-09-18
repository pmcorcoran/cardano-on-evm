import { DatabaseSync } from 'node:sqlite';
import type { ChallengeRecord, ChallengeStore } from './store.js';

/** Each process may open its own connection to the same file. SQLite serializes
 * the conditional DELETE; only its winning caller observes changes === 1. */
export class SqliteChallengeStore implements ChallengeStore {
  readonly #db: DatabaseSync;
  constructor(file: string) {
    this.#db = new DatabaseSync(file);
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS cardano_challenges (id TEXT PRIMARY KEY, payload_hex TEXT NOT NULL, expires_at INTEGER NOT NULL, record_json TEXT NOT NULL)');
  }
  async put(record: ChallengeRecord): Promise<void> {
    this.#db.prepare('INSERT INTO cardano_challenges VALUES (?, ?, ?, ?)').run(record.id, record.payloadHex, record.expiresAt, JSON.stringify(record));
  }
  async get(id: string): Promise<ChallengeRecord | undefined> {
    const row = this.#db.prepare('SELECT record_json FROM cardano_challenges WHERE id = ?').get(id);
    return row ? JSON.parse(row.record_json as string) : undefined;
  }
  async consume(id: string, payloadHex: string, now: number): Promise<boolean> {
    const result = this.#db.prepare('DELETE FROM cardano_challenges WHERE id = ? AND payload_hex = ? AND expires_at > ?').run(id, payloadHex, now);
    return result.changes === 1;
  }
  prune(now: number): void { this.#db.prepare('DELETE FROM cardano_challenges WHERE expires_at <= ?').run(now); }
  close(): void { this.#db.close(); }
}
