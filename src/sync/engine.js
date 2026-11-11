// Inventory synchronization.
//
//   dealer inventory search (or an authorized feed)  ->  Florence gate  ->  units table (D1)
//
// Safety rules enforced here:
//  * a unit is public only when its own source record names the Florence store (and nothing
//    contradicts it) on the most recent successful sync — location is re-verified every run;
//  * conflicting / missing location evidence => quarantined, never shown;
//  * a failed, challenged, partial or suspicious read changes nothing: units keep their last
//    verified time, the site marks them stale, and they are hidden after a grace period;
//  * anti-bot challenges end the run and start a cool-down. We never work around them.
import { config } from '../config.js';
import { q, now, getSetting, setSetting, logError } from '../db.js';
import { vehicleType, family, unitSlug } from './taxonomy.js';
import * as search from './search.js';
import * as feed from './feed.js';

// Small, fast, synchronous content hash (cyrb53) — change detection only, not security.
function hashOf(u) {
  const str = JSON.stringify({ ...u, sourceUrl: undefined });
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const UPSERT = `INSERT INTO units (guid,source_url,status,status_reason,location_name,location_ids,availability,slug,title,year,make,model,family,vtype,condition,stock_number,vin,category,model_type,color,price,msrp,on_sale,seats,data,content_hash,first_seen,first_active,last_checked,last_verified,last_changed)
  VALUES (@guid,@source_url,@status,@status_reason,@location_name,@location_ids,@availability,@slug,@title,@year,@make,@model,@family,@vtype,@condition,@stock_number,@vin,@category,@model_type,@color,@price,@msrp,@on_sale,@seats,@data,@content_hash,@first_seen,@first_active,@last_checked,@last_verified,@last_changed)
  ON CONFLICT(guid) DO UPDATE SET source_url=excluded.source_url,status=excluded.status,status_reason=excluded.status_reason,location_name=excluded.location_name,location_ids=excluded.location_ids,availability=excluded.availability,slug=excluded.slug,title=excluded.title,year=excluded.year,make=excluded.make,model=excluded.model,family=excluded.family,vtype=excluded.vtype,condition=excluded.condition,stock_number=excluded.stock_number,vin=excluded.vin,category=excluded.category,model_type=excluded.model_type,color=excluded.color,price=excluded.price,msrp=excluded.msrp,on_sale=excluded.on_sale,seats=excluded.seats,data=excluded.data,content_hash=excluded.content_hash,first_active=excluded.first_active,last_checked=excluded.last_checked,last_verified=excluded.last_verified,last_changed=excluded.last_changed`;

/** Work out what one source record means for the database. Pure: returns a row + what changed. */
function planUnit(parsed, cls, existing, t, log) {
  const ch = { added: false, updated: false, priceChange: false, removed: false, quarantined: false };
  const hash = hashOf(parsed);
  const wasActive = !!existing && existing.status === 'active';
  if (cls.status === 'quarantined' && (!existing || existing.status !== 'quarantined')) { ch.quarantined = true; log('warn', `QUARANTINED: ${cls.reason} — ${parsed.title || parsed.sourceUrl}`, parsed.guid); }
  if (wasActive && cls.status !== 'active') { ch.removed = true; log('info', `Hidden (${cls.status}): ${existing.title} #${existing.stock_number} — ${cls.reason}`, parsed.guid); }
  if (cls.status === 'active' && !wasActive) { ch.added = true; log('info', `Listed: ${parsed.title} #${parsed.stockNumber} @ ${parsed.evidence.locationName}`, parsed.guid); }
  if (wasActive && cls.status === 'active' && existing.content_hash !== hash) {
    ch.updated = true;
    if (existing.price !== parsed.price) { ch.priceChange = true; log('info', `Price change: ${existing.title} #${existing.stock_number} ${existing.price ?? 'n/a'} -> ${parsed.price ?? 'n/a'}`, parsed.guid); }
  }
  const unchanged = !!existing && existing.content_hash === hash && existing.status === cls.status;
  const keep = ['active', 'unavailable', 'quarantined'].includes(cls.status);
  const row = unchanged ? null : {
    guid: parsed.guid, source_url: parsed.sourceUrl, status: cls.status, status_reason: cls.reason,
    location_name: parsed.evidence.locationName, location_ids: JSON.stringify(parsed.evidence.imageDealershipIds || []),
    availability: parsed.evidence.availabilityText,
    slug: (existing && existing.slug) || (cls.status === 'active' ? unitSlug(parsed) : null), // stable once assigned
    title: parsed.title, year: parsed.year, make: parsed.make, model: parsed.model,
    family: family(parsed), vtype: vehicleType(parsed), condition: parsed.condition,
    stock_number: parsed.stockNumber, vin: parsed.vin, category: parsed.category, model_type: parsed.modelType,
    color: parsed.color, price: parsed.price, msrp: parsed.msrp, on_sale: parsed.onSale ? 1 : 0, seats: (parsed.keySpecs || {}).seats ?? null,
    data: keep ? JSON.stringify(parsed) : null, // only records we may show (or must audit) keep their full payload
    content_hash: hash, last_checked: t,
    last_verified: cls.status === 'active' ? t : (existing ? existing.last_verified : null),
    last_changed: t,
    first_seen: existing ? existing.first_seen : t,
    first_active: existing && existing.first_active ? existing.first_active : (cls.status === 'active' ? t : null),
  };
  return { row, ch };
}

/**
 * Run one synchronization pass.
 * @param {{trigger?:string, fetchImpl?:Function}} opts
 */
export async function runSync(opts = {}) {
  const trigger = opts.trigger || 'schedule';
  if (!config.source.enabled && trigger === 'schedule') return { status: 'skipped', message: 'SYNC_ENABLED is false' };
  if (getSetting('sync_paused', false)) return { status: 'skipped', message: 'Synchronization is suspended by the administrator' };
  const blockedUntil = getSetting('sync_blocked_until', null);
  if (blockedUntil && new Date(blockedUntil) > new Date() && trigger === 'schedule') return { status: 'skipped', message: `Cooling down after an anti-bot challenge until ${blockedUntil}` };
  const lock = getSetting('sync_running', null);
  if (lock && Date.now() - new Date(lock).getTime() < 5 * 60000) return { status: 'skipped', message: 'A sync is already running' };
  await setSetting('sync_running', now());

  const started = now();
  const runId = (await q.run("INSERT INTO sync_runs(started_at,trigger,status) VALUES(?,?,'running')", [started, trigger])).lastId;
  const logs = [];
  const log = (level, message, guid = null) => { if (logs.length < 400) logs.push([level, guid, String(message).slice(0, 500)]); };
  const stats = { source_count: null, added: 0, updated: 0, price_changes: 0, removed: 0, quarantined: 0, errors: 0 };
  let status = 'success';
  let message = '';

  try {
    const usingFeed = !!config.source.feedUrl;
    const label = usingFeed ? 'authorized feed' : 'dealer inventory search';
    const classify = usingFeed ? feed.classifyFeedUnit : search.classifySearchUnit;
    let units;
    try { units = usingFeed ? await feed.fetchFeed(opts.fetchImpl) : await search.fetchAll(opts.fetchImpl); }
    catch (e) { if (e instanceof search.SourceChallenge) { e.challenge = true; } throw e; }
    stats.source_count = units.length;
    if (!units.length) throw new Error('Source returned zero units — refusing to clear inventory');

    const known = new Map((await q.all('SELECT guid,status,content_hash,price,title,stock_number,slug,first_seen,first_active,last_verified FROM units')).map((u) => [u.guid, u]));
    const prevActive = [...known.values()].filter((u) => u.status === 'active').length;
    const results = units.map((u) => ({ u, cls: classify(u) }));
    const nextActive = results.filter((r) => r.cls.status === 'active').length;
    if (prevActive > 20 && nextActive < prevActive * 0.4) throw new Error(`Source would drop Florence inventory from ${prevActive} to ${nextActive} — refusing to apply a suspicious update`);

    const t = now();
    const writes = [];
    const seen = new Set();
    const slugs = new Set([...known.values()].map((u) => u.slug).filter(Boolean));
    for (const { u, cls } of results) {
      if (!u.guid || seen.has(u.guid)) { stats.errors++; log('error', `Record skipped (missing or duplicate id): ${u.title || ''}`); continue; }
      seen.add(u.guid);
      const { row, ch } = planUnit(u, cls, known.get(u.guid) || null, t, log);
      if (row) {
        // A slug collision can only happen with a recycled stock number; fall back to the full id.
        if (row.slug && slugs.has(row.slug) && !(known.get(u.guid) && known.get(u.guid).slug === row.slug)) row.slug = `${row.slug}-${u.guid.slice(6, 12)}`;
        if (row.slug) slugs.add(row.slug);
        writes.push([UPSERT, row]);
      }
      if (ch.added) stats.added++; if (ch.updated) stats.updated++; if (ch.priceChange) stats.price_changes++; if (ch.removed) stats.removed++; if (ch.quarantined) stats.quarantined++;
    }
    const gone = [];
    for (const [guid, row] of known) {
      if (seen.has(guid) || !['active', 'quarantined', 'unavailable'].includes(row.status)) continue;
      if (row.status === 'active') { stats.removed++; log('info', `Removed (no longer listed): ${row.title} #${row.stock_number}`, guid); }
      gone.push(guid);
    }
    // Unchanged units get their verification time refreshed in a single statement.
    writes.push([`UPDATE units SET last_checked=?, last_verified=CASE WHEN status='active' THEN ? ELSE last_verified END WHERE guid IN (SELECT value FROM json_each(?))`, [t, t, JSON.stringify([...seen])]]);
    if (gone.length) writes.push([`UPDATE units SET status='removed', status_reason='No longer listed by the source', last_checked=?, last_changed=? WHERE guid IN (SELECT value FROM json_each(?))`, [t, t, JSON.stringify(gone)]]);
    await q.batch(writes);
    log('info', `${label}: ${units.length} records read, ${nextActive} verified Florence in stock, ${writes.length - 1 - (gone.length ? 1 : 0)} changed.`);
    if (stats.errors) { status = 'partial'; message = `${stats.errors} record(s) rejected`; }
    else message = `${units.length} records read; ${nextActive} Florence units live`;
  } catch (err) {
    status = err.challenge ? 'blocked' : 'failed';
    message = err.message;
    if (status === 'blocked') {
      const until = new Date(Date.now() + config.source.challengeCooldownMinutes * 60000).toISOString();
      await setSetting('sync_blocked_until', until);
      message += ` — scheduled runs paused until ${until}. Verified data kept.`;
    }
    log('error', `Run aborted: ${err.message}`);
    await logError('sync', err);
  }

  const finished = now();
  await q.batch([
    ['UPDATE sync_runs SET finished_at=?,status=?,source_count=?,added=?,updated=?,price_changes=?,removed=?,quarantined=?,errors=?,message=? WHERE id=?',
      [finished, status, stats.source_count, stats.added, stats.updated, stats.price_changes, stats.removed, stats.quarantined, stats.errors, message, runId]],
    ...logs.map(([level, guid, msg]) => ['INSERT INTO sync_log(run_id,at,level,guid,message) VALUES(?,?,?,?,?)', [runId, finished, level, guid, msg]]),
    ['DELETE FROM sync_log WHERE run_id < ?', [runId - 150]],
    ['DELETE FROM sync_runs WHERE id < ?', [runId - 1500]],
  ]);
  if (status === 'success') await setSetting('last_successful_sync', finished);
  await setSetting('last_sync_attempt', { at: finished, status, message });
  await setSetting('sync_running', null);
  return { status, message, runId, ...stats };
}

/** Freshness snapshot used by the public site and the admin dashboard (reads the settings snapshot). */
export function syncHealth() {
  const last = getSetting('last_successful_sync', null);
  const ageMin = last ? (Date.now() - new Date(last).getTime()) / 60000 : Infinity;
  const lock = getSetting('sync_running', null);
  return {
    lastSuccess: last, lastAttempt: getSetting('last_sync_attempt', null), ageMinutes: ageMin,
    paused: !!getSetting('sync_paused', false),
    running: !!lock && Date.now() - new Date(lock).getTime() < 5 * 60000,
    stale: ageMin > config.source.staleAfterMinutes,
  };
}
