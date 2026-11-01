// A minimal Cloudflare D1 stand-in backed by Node's built-in SQLite (node:sqlite),
// so the presets Worker can be tested without wrangler. Applies migrations/*.sql.

import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

class Statement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new Statement(this.db, this.sql, args);
  }
  async first(column) {
    const row = this.db.prepare(this.sql).get(...this.args);
    if (!row) return null;
    const plain = { ...row };
    return column ? plain[column] : plain;
  }
  async all() {
    return { success: true, results: this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r })) };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(r.changes) } };
  }
}

export function createD1() {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  return { prepare: (sql) => new Statement(db, sql), raw: db };
}
