// Thin async layer over Cloudflare D1 (the tests run the same code over a local SQLite shim).
// The schema creates itself on first use, the way Torque CRM's does — there is no migration step.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS units (
    guid TEXT PRIMARY KEY,
    source_url TEXT NOT NULL,
    status TEXT NOT NULL,
    status_reason TEXT,
    location_name TEXT,
    location_ids TEXT,
    availability TEXT,
    slug TEXT,
    title TEXT, year INTEGER, make TEXT, model TEXT, family TEXT, vtype TEXT,
    condition TEXT, stock_number TEXT, vin TEXT, category TEXT, model_type TEXT, color TEXT,
    price INTEGER, msrp INTEGER, on_sale INTEGER DEFAULT 0, seats INTEGER,
    data TEXT,
    content_hash TEXT,
    first_seen TEXT, first_active TEXT, last_checked TEXT, last_verified TEXT, last_changed TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS units_status ON units(status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS units_slug ON units(slug) WHERE slug IS NOT NULL`,
  // Presentation overrides live apart from source data so a sync can never clobber them (and vice versa).
  `CREATE TABLE IF NOT EXISTS overrides (guid TEXT PRIMARY KEY, featured INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, badge TEXT, note TEXT, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT, finished_at TEXT, trigger TEXT, status TEXT,
    source_count INTEGER, added INTEGER DEFAULT 0, updated INTEGER DEFAULT 0, price_changes INTEGER DEFAULT 0,
    removed INTEGER DEFAULT 0, quarantined INTEGER DEFAULT 0, errors INTEGER DEFAULT 0, message TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sync_log (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, at TEXT, level TEXT, guid TEXT, message TEXT)`,
  `CREATE INDEX IF NOT EXISTS sync_log_run ON sync_log(run_id)`,
  `CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
    intent TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL, phone_e164 TEXT, email TEXT, message TEXT, preferred_time TEXT,
    unit_guid TEXT, vehicle TEXT, stock_number TEXT, vehicle_url TEXT,
    source TEXT, attribution TEXT, page_url TEXT, consent_text TEXT, ip_hash TEXT, user_agent TEXT, dedupe_key TEXT,
    crm_status TEXT DEFAULT 'pending', crm_attempts INTEGER DEFAULT 0, crm_last_error TEXT, crm_next_attempt TEXT, crm_delivered_at TEXT, crm_ref TEXT,
    notify_status TEXT DEFAULT 'pending', handled INTEGER DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS leads_created ON leads(created_at)`,
  `CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, day TEXT, type TEXT, path TEXT, unit_guid TEXT, source TEXT, visitor TEXT)`,
  `CREATE INDEX IF NOT EXISTS events_day ON events(day)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS error_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, scope TEXT, message TEXT, detail TEXT)`,
  `CREATE TABLE IF NOT EXISTS rate (k TEXT PRIMARY KEY, n INTEGER NOT NULL, exp INTEGER NOT NULL)`,
  // Specs/features read from dealer unit pages, one row per year|make|model, shared by every unit of that model.
  `CREATE TABLE IF NOT EXISTS model_details (k TEXT PRIMARY KEY, ok INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0, fetched_at TEXT, seats INTEGER, source_url TEXT, data TEXT)`,
];

let d1 = null;
let ready = false;
let settings = {};

export const now = () => new Date().toISOString();

/** `@name` placeholders -> positional `?` (D1 has no named parameters). Arrays pass through. */
function compile(sql, params) {
  if (Array.isArray(params) || params == null) return [sql, params || []];
  const values = [];
  const text = sql.replace(/@([a-zA-Z_]\w*)/g, (m, name) => {
    if (!(name in params)) throw new Error(`Missing SQL parameter @${name}`);
    values.push(params[name]);
    return '?';
  });
  return [text, values];
}
const clean = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
function stmt(sql, params) {
  const [text, values] = compile(sql, params);
  const s = d1.prepare(text);
  return values.length ? s.bind(...values.map(clean)) : s;
}

export const q = {
  all: async (sql, params) => (await stmt(sql, params).all()).results || [],
  get: async (sql, params) => (await stmt(sql, params).first()) || undefined,
  run: async (sql, params) => { const r = await stmt(sql, params).run(); return { lastId: r.meta && r.meta.last_row_id, changes: r.meta && r.meta.changes }; },
  /** Many statements in one round trip (and one transaction). Chunked to stay inside D1's limits. */
  batch: async (list) => { for (let i = 0; i < list.length; i += 50) await d1.batch(list.slice(i, i + 50).map(([sql, params]) => stmt(sql, params))); },
};

/** Bind the database for this request, create tables once per isolate, and load the small settings table. */
export async function useDb(database) {
  if (d1 !== database) { d1 = database; ready = false; }
  if (!d1) throw new Error('No database. Create a D1 database named "ridewithbyron" (see the README).');
  if (!ready) { await d1.batch(SCHEMA.map((s) => d1.prepare(s))); ready = true; }
  settings = {};
  for (const r of await q.all('SELECT key, value FROM settings')) { try { settings[r.key] = JSON.parse(r.value); } catch { /* ignore a bad row */ } }
}

/** Settings are read from the per-request snapshot (synchronous, so templates can use them). */
export const getSetting = (key, fallback = null) => (key in settings && settings[key] !== null ? settings[key] : fallback);
export async function setSetting(key, value) {
  settings[key] = value;
  await q.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, JSON.stringify(value)]);
}

export async function logError(scope, err, detail) {
  const message = err && err.message ? err.message : String(err);
  console.error(`[error] ${scope}: ${message}`);
  try {
    await q.batch([
      ['INSERT INTO error_log(at,scope,message,detail) VALUES(?,?,?,?)', [now(), scope, message.slice(0, 500), String(detail || (err && err.stack) || '').slice(0, 2000)]],
      ['DELETE FROM error_log WHERE id < (SELECT MAX(id) FROM error_log) - 300', []],
    ]);
  } catch { /* never throw from the logger */ }
}

/**
 * Fixed-window rate limit kept in D1. Returns true when the caller is over the limit.
 * One statement; good enough for form and sign-in abuse without any extra Cloudflare product.
 */
export async function overLimit(scope, who, limit, windowSeconds) {
  const t = Math.floor(Date.now() / 1000);
  const k = `${scope}:${who}:${Math.floor(t / windowSeconds)}`;
  const r = await q.get('INSERT INTO rate(k,n,exp) VALUES(?,1,?) ON CONFLICT(k) DO UPDATE SET n=n+1 RETURNING n', [k, t + windowSeconds * 2]);
  if (Math.random() < 0.02) await q.run('DELETE FROM rate WHERE exp < ?', [t]).catch(() => {});
  return (r ? r.n : 1) > limit;
}
