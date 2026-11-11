'use strict';
// Inventory synchronization engine.
//
//   sitemap (discovery)  ->  unit pages (authority)  ->  Florence gate  ->  units table
//
// Safety rules enforced here:
//  * a unit is public only when its own source page says "Available at: <Florence>" AND "In Stock"
//    on the most recent successful check (location is re-verified on every run);
//  * conflicting / missing location evidence => quarantined, never shown;
//  * fetch failures never delete or "freshen" data: the unit keeps its last verified
//    timestamp, the site marks it stale, and it is hidden after a grace period;
//  * anti-bot challenges stop the run. We do not retry around them.
const crypto = require('crypto');
const config = require('../config');
const { db, now, getSetting, setSetting, logError } = require('../db');
const { parseSitemap, parseUnitPage, classifyUnit, isChallengePage } = require('./parse');
const { vehicleType, family, unitSlug } = require('./taxonomy');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let running = false;
let lastRequestAt = 0;

class ChallengeError extends Error {}

async function politeFetch(url, fetchImpl = fetch) {
  const wait = lastRequestAt + config.source.requestDelayMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': config.source.userAgent, Accept: 'text/html,application/xml;q=0.9,*/*;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.text();
  if (isChallengePage(res.status, body)) throw new ChallengeError(`Anti-bot challenge at ${new URL(url).pathname} (HTTP ${res.status})`);
  return { status: res.status, body, finalUrl: res.url || url };
}

const hashOf = (u) => crypto.createHash('sha1').update(JSON.stringify({ ...u, sourceUrl: undefined })).digest('hex');

function makeLogger(runId) {
  const ins = db.prepare('INSERT INTO sync_log(run_id,at,level,guid,message) VALUES(?,?,?,?,?)');
  return (level, message, guid = null) => {
    ins.run(runId, now(), level, guid, String(message).slice(0, 600));
    if (level !== 'info') console.log(`[sync:${level}] ${guid ? guid.slice(0, 8) + ' ' : ''}${message}`);
  };
}

/** Apply one fetched+parsed page to the database. Returns what changed. */
function applyUnit(parsed, cls, existing, log) {
  const t = now();
  const changes = { added: false, updated: false, priceChange: false, removed: false, quarantined: false };
  const hash = hashOf(parsed);
  const wasActive = existing && existing.status === 'active';
  const becameActive = cls.status === 'active' && !wasActive;

  if (cls.status === 'quarantined' && (!existing || existing.status !== 'quarantined')) {
    changes.quarantined = true;
    log('warn', `QUARANTINED: ${cls.reason} — ${parsed.title || parsed.sourceUrl}`, parsed.guid);
  }
  if (wasActive && cls.status !== 'active') {
    changes.removed = true;
    log('info', `Hidden (${cls.status}): ${existing.title} #${existing.stock_number} — ${cls.reason}`, parsed.guid);
  }
  if (becameActive) {
    changes.added = true;
    log('info', `Listed: ${parsed.title} #${parsed.stockNumber} @ ${parsed.evidence.locationName}`, parsed.guid);
  }
  if (wasActive && cls.status === 'active' && existing.content_hash !== hash) {
    changes.updated = true;
    if (existing.price !== parsed.price) {
      changes.priceChange = true;
      log('info', `Price change: ${existing.title} #${existing.stock_number} ${existing.price ?? 'n/a'} -> ${parsed.price ?? 'n/a'}`, parsed.guid);
    }
  }

  // Keep the public slug stable once assigned so URLs never churn.
  const slug = (existing && existing.slug) || (cls.status === 'active' ? unitSlug(parsed) : null);
  const row = {
    guid: parsed.guid, source_url: parsed.sourceUrl, status: cls.status, status_reason: cls.reason,
    location_name: parsed.evidence.locationName, location_ids: JSON.stringify(parsed.evidence.imageDealershipIds),
    availability: parsed.evidence.availabilityText, slug,
    title: parsed.title, year: parsed.year, make: parsed.make, model: parsed.model,
    family: family(parsed), vtype: vehicleType(parsed), condition: parsed.condition,
    stock_number: parsed.stockNumber, vin: parsed.vin, category: parsed.category, model_type: parsed.modelType,
    color: parsed.color, price: parsed.price, msrp: parsed.msrp, on_sale: parsed.onSale ? 1 : 0,
    seats: parsed.keySpecs.seats,
    // Only verified-Florence records keep their full payload; others keep just enough to audit.
    data: cls.status === 'active' || cls.status === 'unavailable' || cls.status === 'quarantined' ? JSON.stringify(parsed) : null,
    content_hash: hash, last_checked: t,
    last_verified: cls.status === 'active' ? t : (existing ? existing.last_verified : null),
    last_changed: !existing || existing.content_hash !== hash || existing.status !== cls.status ? t : existing.last_changed,
    first_seen: existing ? existing.first_seen : t,
    first_active: existing && existing.first_active ? existing.first_active : (cls.status === 'active' ? t : null),
  };
  db.prepare(`INSERT INTO units (guid,source_url,status,status_reason,location_name,location_ids,availability,slug,title,year,make,model,family,vtype,condition,stock_number,vin,category,model_type,color,price,msrp,on_sale,seats,data,content_hash,first_seen,first_active,last_checked,last_verified,last_changed,in_sitemap,fail_count)
    VALUES (@guid,@source_url,@status,@status_reason,@location_name,@location_ids,@availability,@slug,@title,@year,@make,@model,@family,@vtype,@condition,@stock_number,@vin,@category,@model_type,@color,@price,@msrp,@on_sale,@seats,@data,@content_hash,@first_seen,@first_active,@last_checked,@last_verified,@last_changed,1,0)
    ON CONFLICT(guid) DO UPDATE SET source_url=excluded.source_url,status=excluded.status,status_reason=excluded.status_reason,location_name=excluded.location_name,location_ids=excluded.location_ids,availability=excluded.availability,slug=excluded.slug,title=excluded.title,year=excluded.year,make=excluded.make,model=excluded.model,family=excluded.family,vtype=excluded.vtype,condition=excluded.condition,stock_number=excluded.stock_number,vin=excluded.vin,category=excluded.category,model_type=excluded.model_type,color=excluded.color,price=excluded.price,msrp=excluded.msrp,on_sale=excluded.on_sale,seats=excluded.seats,data=COALESCE(excluded.data, CASE WHEN excluded.status IN ('removed') THEN units.data ELSE NULL END),content_hash=excluded.content_hash,first_active=excluded.first_active,last_checked=excluded.last_checked,last_verified=excluded.last_verified,last_changed=excluded.last_changed,fail_count=0`).run(row);
  return changes;
}

/**
 * Run one synchronization pass.
 * @param {{trigger?:string, fetchImpl?:Function, limit?:number}} opts
 */
async function runSync(opts = {}) {
  const trigger = opts.trigger || 'schedule';
  if (running) return { status: 'skipped', message: 'A sync is already running' };
  if (getSetting('sync_paused', false) && trigger !== 'manual-override') {
    db.prepare('INSERT INTO sync_runs(started_at,finished_at,trigger,status,message) VALUES(?,?,?,?,?)').run(now(), now(), trigger, 'skipped', 'Synchronization is suspended by administrator');
    return { status: 'skipped', message: 'Synchronization is suspended' };
  }
  const blockedUntil = getSetting('sync_blocked_until', null);
  if (blockedUntil && new Date(blockedUntil) > new Date() && trigger === 'schedule') {
    return { status: 'skipped', message: `Cooling down after an anti-bot challenge until ${blockedUntil}` };
  }
  running = true;
  const runId = db.prepare("INSERT INTO sync_runs(started_at,trigger,status) VALUES(?,?,'running')").run(now(), trigger).lastInsertRowid;
  const log = makeLogger(runId);
  const stats = { sitemap_count: null, fetched: 0, added: 0, updated: 0, price_changes: 0, removed: 0, quarantined: 0, errors: 0 };
  let status = 'success';
  let message = '';
  const finish = () => {
    db.prepare('UPDATE sync_runs SET finished_at=?,status=?,sitemap_count=?,fetched=?,added=?,updated=?,price_changes=?,removed=?,quarantined=?,errors=?,message=? WHERE id=?')
      .run(now(), status, stats.sitemap_count, stats.fetched, stats.added, stats.updated, stats.price_changes, stats.removed, stats.quarantined, stats.errors, message, runId);
    if (status === 'success') setSetting('last_successful_sync', now());
    setSetting('last_sync_attempt', { at: now(), status, message });
    db.prepare('DELETE FROM sync_log WHERE run_id < ?').run(runId - 200);
    running = false;
  };

  try {
    if (!process.env.INVENTORY_FEED_URL && config.source.mode === 'search') {
      const search = require('./search');
      let units;
      try { units = await search.fetchAll(opts.fetchImpl); } catch (e) { if (e instanceof search.SourceChallenge) throw new ChallengeError(e.message); throw e; }
      // Rows left over from page-by-page discovery are meaningless in this mode.
      db.prepare("DELETE FROM units WHERE status IN ('pending','catalog')").run();
      await runFeed(opts, log, stats, { units, classify: search.classifySearchUnit, label: 'dealer search' });
      if (stats.errors) { status = 'partial'; message = `${stats.errors} record(s) rejected`; } else message = `Dealer search applied: ${stats.fetched} records`;
      return { status, message, runId, ...stats };
    }
    if (process.env.INVENTORY_FEED_URL) { await runFeed(opts, log, stats); if (stats.errors) { status = 'partial'; message = `${stats.errors} feed record(s) rejected`; } else message = `Feed applied: ${stats.fetched} records`; return { status, message, runId, ...stats }; }
    // 1) Discovery
    // The source's WAF occasionally challenges the sitemap. We back off once and ask again later;
    // a second challenge ends this run (the next scheduled run tries again). We never solve challenges.
    let sm;
    try {
      sm = await politeFetch(config.source.baseUrl + config.source.sitemapPath, opts.fetchImpl);
    } catch (err) {
      if (!(err instanceof ChallengeError)) throw err;
      log('warn', `${err.message} — backing off ${config.source.challengeBackoffMs / 1000}s before one retry`);
      await sleep(config.source.challengeBackoffMs);
      sm = await politeFetch(config.source.baseUrl + config.source.sitemapPath, opts.fetchImpl);
    }
    if (sm.status !== 200) throw new Error(`Sitemap returned HTTP ${sm.status}`);
    const entries = parseSitemap(sm.body);
    stats.sitemap_count = entries.length;
    if (entries.length === 0) throw new Error('Sitemap contained no unit pages — source structure may have changed');
    const prevCount = getSetting('last_sitemap_count', 0);
    if (prevCount > 50 && entries.length < prevCount * 0.4) {
      throw new Error(`Sitemap shrank from ${prevCount} to ${entries.length} unit pages — refusing to act on a suspicious source change`);
    }
    setSetting('last_sitemap_count', entries.length);
    const inMap = new Map(entries.map((e) => [e.guid, e]));

    const known = new Map(db.prepare('SELECT * FROM units').all().map((u) => [u.guid, u]));
    db.exec('UPDATE units SET in_sitemap=0');
    const markIn = db.prepare('UPDATE units SET in_sitemap=1, source_url=? WHERE guid=?');
    const addPending = db.prepare("INSERT OR IGNORE INTO units(guid,source_url,status,first_seen,in_sitemap) VALUES(?,?,'pending',?,1)");
    db.transaction(() => { for (const e of entries) { if (known.has(e.guid)) markIn.run(e.url, e.guid); else addPending.run(e.guid, e.url, now()); } })();

    // 2) Work queue: everything public or flagged is re-verified every run; the rest rotates.
    const all = db.prepare('SELECT * FROM units').all();
    const cutoff = new Date(Date.now() - config.source.recheckOthersHours * 3600e3).toISOString();
    const must = all.filter((u) => ['active', 'quarantined', 'pending'].includes(u.status) || (['unavailable', 'removed'].includes(u.status) && u.in_sitemap));
    const others = all
      .filter((u) => ['other_location', 'catalog'].includes(u.status) && u.in_sitemap && (!u.last_checked || u.last_checked < cutoff))
      .sort((a, b) => (a.last_checked || '').localeCompare(b.last_checked || ''))
      .slice(0, config.source.maxOthersPerRun);
    // Priority: what the public can see first, then flagged units, then never-checked pages, then the rotation.
    const rank = { active: 0, quarantined: 1, unavailable: 2, removed: 2, pending: 3 };
    // Never-checked pages: older model years first (current/next-year pages are mostly manufacturer catalog entries).
    const slugYear = (u) => Number((u.source_url.match(/-((?:19|20)\d{2})-[A-Za-z-]+-[A-Z]{2}-[0-9a-f]{8}-/) || [])[1]) || 9999;
    must.sort((a, b) => rank[a.status] - rank[b.status] || a.fail_count - b.fail_count || (a.status === 'pending' ? slugYear(a) - slugYear(b) : 0) || (a.last_checked || '').localeCompare(b.last_checked || ''));
    let queue = [...must, ...others];
    const cap = opts.limit || config.source.maxPagesPerRun;
    const deferred = Math.max(0, queue.length - cap);
    queue = queue.slice(0, cap);
    if (deferred) log('info', `${deferred} page(s) deferred to the next run (per-run cap ${cap}).`);
    log('info', `Sitemap lists ${entries.length} unit pages. Checking ${queue.length} (${must.length} priority, ${others.length} rotating).`);

    // 3) Fetch + verify each page, one at a time
    let consecutive = 0;
    for (const u of queue) {
      if (getSetting('sync_paused', false) && trigger !== 'manual-override') { status = 'partial'; message = 'Suspended by administrator mid-run'; log('warn', message); break; }
      try {
        // Discovered on the Florence site, verified on the site that states each unit's location.
        const verifyUrl = config.source.verifyBaseUrl + new URL(u.source_url).pathname;
        const res = await politeFetch(verifyUrl, opts.fetchImpl);
        stats.fetched++;
        const gone = res.status === 404 || res.status === 410 || !res.finalUrl.toLowerCase().includes(u.guid);
        if (gone && !u.last_verified && u.status !== 'removed') {
          // Never verified and not resolvable where location is stated: hold it, don't guess.
          if (u.status !== 'quarantined') { stats.quarantined++; log('warn', `QUARANTINED: page not available on the location-verifying site (HTTP ${res.status})`, u.guid); }
          db.prepare("UPDATE units SET status='quarantined', status_reason=?, last_checked=? WHERE guid=?").run(`Not resolvable on location-verifying site (HTTP ${res.status})`, now(), u.guid);
          consecutive = 0;
          continue;
        }
        if (gone) {
          if (u.status === 'active') { stats.removed++; log('info', `Removed from source (HTTP ${res.status}): ${u.title} #${u.stock_number}`, u.guid); }
          db.prepare("UPDATE units SET status='removed', status_reason=?, last_checked=?, last_changed=? WHERE guid=?").run(`Source page gone (HTTP ${res.status})`, now(), now(), u.guid);
          consecutive = 0;
          continue;
        }
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        const parsed = parseUnitPage(res.body, u.source_url);
        if (parsed.guid !== u.guid) throw new Error('Parsed GUID does not match requested unit');
        const cls = classifyUnit(parsed, config.source);
        const ch = applyUnit(parsed, cls, u.status === 'pending' ? null : u, log);
        if (ch.added) stats.added++;
        if (ch.updated) stats.updated++;
        if (ch.priceChange) stats.price_changes++;
        if (ch.removed) stats.removed++;
        if (ch.quarantined) stats.quarantined++;
        consecutive = 0;
      } catch (err) {
        if (err instanceof ChallengeError) {
          // Move this page to the back of the queue so one URL can never block the whole sync.
          db.prepare('UPDATE units SET fail_count=fail_count+1 WHERE guid=?').run(u.guid);
          throw err;
        }
        stats.errors++; consecutive++;
        db.prepare('UPDATE units SET fail_count=fail_count+1 WHERE guid=?').run(u.guid);
        log('error', `Fetch/parse failed: ${err.message}`, u.guid);
        if (consecutive >= config.source.maxConsecutiveErrors) throw new Error(`${consecutive} consecutive failures — aborting run, keeping last verified data`);
      }
    }
    if (stats.errors > 0 && status === 'success') { status = 'partial'; message = `${stats.errors} page(s) could not be checked; their last verified data was kept`; }
    if (opts.limit && status === 'success') { status = 'partial'; message = `Limited test run (${stats.fetched} pages)`; }
    const backlog = db.prepare("SELECT COUNT(*) n FROM units WHERE status='pending'").get().n;
    const everSucceeded = !!getSetting('last_successful_sync', null);
    // Until the very first full pass completes, the catalog is incomplete and must not be presented as current.
    if (backlog && status === 'success' && !everSucceeded) { status = 'partial'; message = `Initial load in progress: ${backlog} page(s) still to check`; }
    else if (backlog && status === 'success') message = `Checked ${stats.fetched} pages; ${backlog} newly discovered page(s) queued for their first check`;
    if (!message) message = `Checked ${stats.fetched} pages`;
    const counts = db.prepare("SELECT status, COUNT(*) n FROM units GROUP BY status").all().map((r) => `${r.status}:${r.n}`).join(' ');
    log('info', `Run finished (${status}). ${counts}`);
  } catch (err) {
    status = err instanceof ChallengeError ? 'blocked' : 'failed';
    message = err.message;
    if (status === 'blocked') {
      const until = new Date(Date.now() + config.source.challengeCooldownMinutes * 60000).toISOString();
      setSetting('sync_blocked_until', until);
      message += ` — scheduled runs paused until ${until}. Verified data kept.`;
    }
    log('error', `Run aborted: ${err.message}`);
    logError('sync', err);
  } finally {
    finish();
  }
  return { status, message, runId, ...stats };
}

/** Authorized-feed mode: the feed is the full truth, so anything absent from a good feed is removed. */
async function runFeed(opts, log, stats, given) {
  const { fetchFeed, classifyFeedUnit: feedClassify } = require('./feed');
  const classifyFeedUnit = given ? given.classify : feedClassify;
  const label = given ? given.label : 'authorized feed';
  const units = given ? given.units : await fetchFeed(opts.fetchImpl);
  if (!units.length) throw new Error('Feed returned zero units — refusing to clear inventory');
  const prev = db.prepare("SELECT COUNT(*) n FROM units WHERE status='active'").get().n;
  const known = new Map(db.prepare('SELECT * FROM units').all().map((u) => [u.guid, u]));
  const seen = new Set();
  const results = units.map((u) => ({ u, cls: classifyFeedUnit(u) }));
  const nextActive = results.filter((r) => r.cls.status === 'active').length;
  if (prev > 20 && nextActive < prev * 0.4) throw new Error(`Feed would drop Florence inventory from ${prev} to ${nextActive} — refusing to apply a suspicious update`);
  stats.sitemap_count = units.length;
  for (const { u, cls } of results) {
    stats.fetched++;
    if (!u.guid || seen.has(u.guid)) { stats.errors++; log('error', `Feed record skipped (missing or duplicate id): ${u.title || ''}`); continue; }
    seen.add(u.guid);
    const ch = applyUnit(u, cls, known.get(u.guid) || null, log);
    if (ch.added) stats.added++; if (ch.updated) stats.updated++; if (ch.priceChange) stats.price_changes++; if (ch.removed) stats.removed++; if (ch.quarantined) stats.quarantined++;
  }
  for (const [guid, row] of known) {
    if (seen.has(guid) || !['active', 'quarantined', 'unavailable'].includes(row.status)) continue;
    if (row.status === 'active') { stats.removed++; log('info', `Removed (no longer listed): ${row.title} #${row.stock_number}`, guid); }
    db.prepare("UPDATE units SET status='removed', status_reason='No longer listed by the source', last_checked=?, last_changed=? WHERE guid=?").run(now(), now(), guid);
  }
  log('info', `${label}: ${units.length} records read, ${nextActive} verified Florence in stock.`);
}

/** Freshness snapshot used by the public site and the admin dashboard. */
function syncHealth() {
  const last = getSetting('last_successful_sync', null);
  const attempt = getSetting('last_sync_attempt', null);
  const ageMin = last ? (Date.now() - new Date(last).getTime()) / 60000 : Infinity;
  return {
    lastSuccess: last, lastAttempt: attempt, ageMinutes: ageMin,
    paused: !!getSetting('sync_paused', false), running,
    stale: ageMin > config.source.staleAfterMinutes,
  };
}

let timer = null;
function startScheduler() {
  if (!config.source.enabled) { console.log('[sync] scheduler disabled (SYNC_ENABLED=false)'); return; }
  const tick = () => runSync({ trigger: 'schedule' }).catch((e) => logError('sync-scheduler', e));
  const last = getSetting('last_successful_sync', null);
  const due = !last || Date.now() - new Date(last).getTime() > config.source.intervalMinutes * 60000;
  setTimeout(tick, due ? 5000 : 60000);
  timer = setInterval(tick, config.source.intervalMinutes * 60000);
  timer.unref();
  console.log(`[sync] scheduler started: every ${config.source.intervalMinutes} min`);
}

module.exports = { runSync, syncHealth, startScheduler, applyUnit, isRunning: () => running };
