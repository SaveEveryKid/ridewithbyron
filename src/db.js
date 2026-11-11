'use strict';
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS units (
  guid TEXT PRIMARY KEY,               -- stable DX1 product GUID (prevents duplicates)
  source_url TEXT NOT NULL,
  status TEXT NOT NULL,                -- active | unavailable | other_location | catalog | quarantined | removed | pending
  status_reason TEXT,
  location_name TEXT,                  -- raw "Available at" text from source
  location_ids TEXT,                   -- raw dealership ids seen in private photo paths (JSON)
  availability TEXT,
  slug TEXT,
  title TEXT, year INTEGER, make TEXT, model TEXT, family TEXT, vtype TEXT,
  condition TEXT, stock_number TEXT, vin TEXT, category TEXT, model_type TEXT, color TEXT,
  price INTEGER, msrp INTEGER, on_sale INTEGER DEFAULT 0, seats INTEGER,
  data TEXT,                           -- full parsed record (JSON), exactly as read from source
  content_hash TEXT,
  first_seen TEXT, first_active TEXT, last_checked TEXT, last_verified TEXT, last_changed TEXT,
  in_sitemap INTEGER DEFAULT 1,
  fail_count INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS units_status ON units(status);
CREATE UNIQUE INDEX IF NOT EXISTS units_slug ON units(slug) WHERE slug IS NOT NULL;

-- Presentation overrides live apart from source data so a sync can never clobber them (and vice versa).
CREATE TABLE IF NOT EXISTS overrides (
  guid TEXT PRIMARY KEY, featured INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, badge TEXT, note TEXT, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT, finished_at TEXT, trigger TEXT,
  status TEXT,                         -- running | success | partial | failed | blocked | skipped
  sitemap_count INTEGER, fetched INTEGER DEFAULT 0, added INTEGER DEFAULT 0, updated INTEGER DEFAULT 0,
  price_changes INTEGER DEFAULT 0, removed INTEGER DEFAULT 0, quarantined INTEGER DEFAULT 0, errors INTEGER DEFAULT 0,
  message TEXT
);
CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, at TEXT, level TEXT, guid TEXT, message TEXT
);
CREATE INDEX IF NOT EXISTS sync_log_run ON sync_log(run_id);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
  intent TEXT NOT NULL,                -- quote | availability | visit | financing | question | text
  name TEXT NOT NULL, phone TEXT NOT NULL, phone_e164 TEXT, email TEXT, message TEXT,
  preferred_time TEXT,
  unit_guid TEXT, vehicle TEXT, stock_number TEXT, vehicle_url TEXT,
  source TEXT, attribution TEXT,       -- classified source + raw UTM/click ids/referrer (JSON)
  page_url TEXT, consent_text TEXT, ip_hash TEXT, user_agent TEXT,
  dedupe_key TEXT,
  crm_status TEXT DEFAULT 'pending',   -- pending | delivered | failed | not_configured
  crm_attempts INTEGER DEFAULT 0, crm_last_error TEXT, crm_next_attempt TEXT, crm_delivered_at TEXT, crm_ref TEXT,
  notify_status TEXT DEFAULT 'pending',
  handled INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS leads_created ON leads(created_at);

CREATE TABLE IF NOT EXISTS events (   -- lightweight first-party traffic log (no cookies, no PII)
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, day TEXT, type TEXT, path TEXT, unit_guid TEXT, source TEXT, visitor TEXT
);
CREATE INDEX IF NOT EXISTS events_day ON events(day);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS error_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, scope TEXT, message TEXT, detail TEXT);
`);

const now = () => new Date().toISOString();
const getSetting = (key, fallback = null) => {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (!r) return fallback;
  try { return JSON.parse(r.value); } catch (e) { return fallback; }
};
const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
const logError = (scope, err, detail) => {
  const message = err && err.message ? err.message : String(err);
  console.error(`[error] ${scope}: ${message}`);
  try {
    db.prepare('INSERT INTO error_log(at,scope,message,detail) VALUES(?,?,?,?)').run(now(), scope, message.slice(0, 500), (detail || (err && err.stack) || '').slice(0, 2000));
    db.prepare('DELETE FROM error_log WHERE id < (SELECT MAX(id) FROM error_log) - 500').run();
  } catch (e) { /* never throw from the logger */ }
};

module.exports = { db, now, getSetting, setSetting, logError };
