// A stand-in for Cloudflare D1 backed by an in-memory SQLite database, so the tests run the
// real SQL. Implements the parts of the D1 API the site uses: prepare/bind/all/first/run and batch.
import Database from 'better-sqlite3';

export function makeD1() {
  const db = new Database(':memory:');
  const stmt = (sql, params = []) => ({
    sql, params,
    bind: (...p) => stmt(sql, p),
    all: async () => { const s = db.prepare(sql); return { results: s.reader ? s.all(...params) : (s.run(...params), []) }; },
    first: async () => { const s = db.prepare(sql); return s.reader ? (s.get(...params) ?? null) : (s.run(...params), null); },
    run: async () => { const s = db.prepare(sql); if (s.reader) { s.all(...params); return { meta: {} }; } const r = s.run(...params); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; },
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (list) => db.transaction(() => list.map((s) => { const p = db.prepare(s.sql); return p.reader ? { results: p.all(...s.params) } : (p.run(...s.params), { results: [] }); }))(),
    raw: db,
  };
}
