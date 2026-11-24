/**
 * Minimal D1Database implementation over node:sqlite for fast, real-SQL tests.
 * Covers the subset of the D1 API the app uses: prepare/bind/first/all/run/raw and batch.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

type Bindable = string | number | null | bigint | Uint8Array;

class Stmt {
  constructor(private db: DatabaseSync, private sql: string, private params: Bindable[] = []) {}
  bind(...params: unknown[]) {
    return new Stmt(this.db, this.sql, params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : (p as Bindable))));
  }
  // D1 uses ?NNN numbered params; node:sqlite accepts them as positional when passed in order.
  private prepared() {
    return this.db.prepare(this.sql);
  }
  async first<T>(col?: string): Promise<T | null> {
    const row = this.prepared().get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (col ? row[col] : { ...row }) as T;
  }
  async all<T>() {
    const results = this.prepared().all(...this.params).map((r) => ({ ...(r as object) })) as T[];
    return { results, success: true, meta: {} };
  }
  async run() {
    const r = this.prepared().run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async raw<T>() {
    return this.prepared().all(...this.params).map((r) => Object.values(r as object)) as T[];
  }
  _exec() {
    return /^\s*(select|with)/i.test(this.sql) ? this.all() : this.run();
  }
}

export function createTestD1(): D1Database {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  const api = {
    prepare: (sql: string) => new Stmt(db, sql),
    batch: async (stmts: Stmt[]) => Promise.all(stmts.map((s) => s._exec())),
    exec: async (sql: string) => {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
  return api as unknown as D1Database;
}
