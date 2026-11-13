import { normalizePhone } from '../shared/phone';
import { nowIso, transaction, type DB } from './db';

export interface SuppressionEntry {
  number: string;
  reason: string | null;
  createdAt: string;
}

/** Numbers that must never be messaged (opt-outs, complaints, do-not-contact lists). */
export class SuppressionStore {
  constructor(private readonly db: DB) {}

  has(number: string): boolean {
    return this.db.prepare('SELECT 1 FROM suppressions WHERE number = ?').get(number) !== undefined;
  }

  filter(numbers: string[]): Set<string> {
    const found = new Set<string>();
    const stmt = this.db.prepare('SELECT 1 FROM suppressions WHERE number = ?');
    for (const n of numbers) if (stmt.get(n) !== undefined) found.add(n);
    return found;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM suppressions').get() as { n: number }).n;
  }

  list(opts: { search?: string; limit: number; offset: number }): { items: SuppressionEntry[]; total: number } {
    const like = `%${(opts.search ?? '').replace(/[^\d+]/g, '')}%`;
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM suppressions WHERE number LIKE ?').get(like) as { n: number }).n;
    const rows = this.db
      .prepare('SELECT number, reason, created_at FROM suppressions WHERE number LIKE ? ORDER BY created_at DESC, number LIMIT ? OFFSET ?')
      .all(like, opts.limit, opts.offset) as { number: string; reason: string | null; created_at: string }[];
    return { items: rows.map((r) => ({ number: r.number, reason: r.reason, createdAt: r.created_at })), total };
  }

  add(numbers: string[], reason: string | null, defaultCountry: string): { added: number; existing: number; invalid: string[] } {
    const invalid: string[] = [];
    let added = 0;
    let existing = 0;
    const stmt = this.db.prepare('INSERT OR IGNORE INTO suppressions (number, reason, created_at) VALUES (?, ?, ?)');
    const now = nowIso();
    transaction(this.db, () => {
      for (const raw of numbers) {
        if (!raw.trim()) continue;
        const result = normalizePhone(raw, defaultCountry);
        if (!result.ok) {
          invalid.push(raw.trim());
          continue;
        }
        if (stmt.run(result.e164, reason, now).changes === 1) added += 1;
        else existing += 1;
      }
    });
    return { added, existing, invalid };
  }

  remove(number: string): boolean {
    return this.db.prepare('DELETE FROM suppressions WHERE number = ?').run(number).changes === 1;
  }
}
