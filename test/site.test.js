// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeD1 } from './d1-shim.js';
import { config, initConfig } from '../src/config.js';
import { useDb, q, getSetting, setSetting, overLimit } from '../src/db.js';
import { classifyUnit, isChallengePage } from '../src/sync/gate.js';
import { mapHit, classifySearchUnit, parseSearchConfig } from '../src/sync/search.js';
import { mapFeedUnit, classifyFeedUnit } from '../src/sync/feed.js';
import { runSync, syncHealth } from '../src/sync/engine.js';
import * as inv from '../src/inventory.js';
import * as leads from '../src/leads.js';
import * as sec from '../src/security.js';
import worker from '../src/worker.js';

const fx = (n) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const ENV = { DB: makeD1(), ADMIN_PASSWORD: 'correct horse battery staple', SITE_URL: 'https://www.ridewithbyron.com' };
initConfig(ENV);
config.source.challengeBackoffMs = 0;
await useDb(ENV.DB);

const F = config.source.florenceDealershipId;
const TUSC_ID = '06fcbe5c-a659-49e3-93ff-b006014cc892';
const tusc = JSON.parse(fx('search-hit-tuscumbia.json'));           // a real record from the dealer search
const florence = (id, stock, extra = {}) => {                        // the same record as the Florence store would carry it
  const h = JSON.parse(JSON.stringify(tusc).replaceAll(TUSC_ID, F));
  return { ...h, objectID: id, StockNumber: stock, DealershipName: 'Shoals Outdoor Sports - Florence', ...extra };
};
const A = 'aaaaaaaa-0000-0000-0000-000000000001', B = 'aaaaaaaa-0000-0000-0000-000000000002', C = 'aaaaaaaa-0000-0000-0000-000000000003';
const PAGE = fx('florence-instock-boat.html');                       // a real dealer page (carries the search setup)
const source = (hits, nbHits) => async (u) => (String(u).includes('algolia.net')
  ? { ok: true, status: 200, json: async () => ({ hits, nbHits: nbHits ?? hits.length, nbPages: 1 }) }
  : { ok: true, status: 200, url: u, text: async () => PAGE });
const stocks = async () => (await inv.allPublic()).map((u) => u.stock_number).sort();
const sync = async (impl) => { await useDb(ENV.DB); return runSync({ trigger: 'test', fetchImpl: impl }); };

test('Florence gate: every way a record can be wrong is caught', () => {
  assert.equal(classifySearchUnit(mapHit(tusc)).status, 'other_location');
  assert.equal(classifySearchUnit(mapHit(florence(A, 'S1'))).status, 'active');
  assert.equal(classifySearchUnit(mapHit(florence(A, 'S1', { DealershipName: 'Shoals Outdoor Sports - Tuscumbia' }))).status, 'quarantined', 'name vs photo-id conflict');
  assert.equal(classifySearchUnit(mapHit({ ...tusc, DealershipName: 'Shoals Outdoor Sports - Florence' })).status, 'quarantined', 'Florence name, another store photo id');
  assert.equal(classifySearchUnit(mapHit(florence(A, 'S1', { DealershipName: undefined }))).status, 'quarantined');
  assert.equal(classifySearchUnit(mapHit(florence(A, 'S1', { DealershipName: 'Florence Powersports', PhotoUrl: '', PhotoLists: [] }))).status, 'other_location', 'look-alike names never pass');
  assert.equal(classifySearchUnit(mapHit(florence(A, ''))).status, 'quarantined', 'no stock number');
  assert.equal(classifySearchUnit(mapHit(florence('not-a-guid', 'S1'))).status, 'quarantined');
  const base = mapHit(florence(A, 'S1'));
  assert.equal(classifyUnit({ ...base, evidence: { ...base.evidence, availabilityText: 'Sold' } }, config.source).status, 'unavailable');
});

test('source records are mapped faithfully; nothing is invented', () => {
  const u = mapHit(tusc);
  assert.deepEqual([u.stockNumber, u.price, u.year, u.make, u.condition], ['H4513A', 3999, 1978, 'Alumacraft', 'Used']);
  assert.ok(u.images.length >= 1 && u.images.every((i) => i.startsWith('https://cdpcdn.dx1app.com/')));
  const sale = mapHit(florence(A, 'S1', { Price: 5000, SalePrice: 4500, Msrp: 5200 }));
  assert.deepEqual([sale.price, sale.msrp, sale.onSale], [4500, 5000, true]);
  assert.equal(mapHit(florence(A, 'S1', { Price: 0, SalePrice: 0, Msrp: 0 })).price, null, 'no price stays "call for price"');
  assert.equal(parseSearchConfig(PAGE).appId, 'RBG3H22Y5V');
  assert.throws(() => parseSearchConfig('<html>no config</html>'));
  assert.equal(isChallengePage(403, '<title>Azure WAF</title>'), true);
  assert.equal(isChallengePage(200, PAGE), false);
});

test('sync lists only verified Florence units', async () => {
  const r = await sync(source([florence(A, 'S1'), florence(B, 'S2', { Price: 9000 }), tusc]));
  assert.equal(r.status, 'success');
  assert.equal(r.added, 2);
  assert.deepEqual(await stocks(), ['S1', 'S2']);
  assert.equal((await q.get('SELECT status FROM units WHERE guid=?', [tusc.objectID])).status, 'other_location');
  assert.equal((await q.get('SELECT COUNT(*) n FROM units')).n, 3, 'no duplicates');
  assert.ok(syncHealth().lastSuccess);
});

test('price changes are applied; admin overrides survive; unchanged units are only re-verified', async () => {
  await q.run("INSERT INTO overrides(guid,featured,note) VALUES(?,1,'Great boat')", [A]);
  await q.run("UPDATE units SET last_verified='2020-01-01T00:00:00.000Z' WHERE guid=?", [B]);
  const before = await inv.getByGuid(B);
  const r = await sync(source([florence(A, 'S1', { Price: 3500 }), florence(B, 'S2', { Price: 9000 }), tusc]));
  assert.equal(r.price_changes, 1);
  const a = await inv.getByGuid(A);
  assert.deepEqual([a.price, a.featured, a.note], [3500, 1, 'Great boat']);
  const b = await inv.getByGuid(B);
  assert.equal(b.last_changed, before.last_changed, 'unchanged record is not rewritten');
  assert.ok(b.last_verified > '2026', 'but its verification time is refreshed');
});

test('a unit moved to another store disappears; it returns when verified again', async () => {
  let r = await sync(source([florence(A, 'S1', { Price: 3500 }), florence(B, 'S2', { Price: 9000, DealershipName: 'Shoals Outdoor Sports - Tuscumbia' }), tusc]));
  assert.equal(r.quarantined, 1);
  assert.deepEqual(await stocks(), ['S1']);
  r = await sync(source([florence(A, 'S1', { Price: 3500 }), florence(B, 'S2', { Price: 9000 }), tusc]));
  assert.deepEqual(await stocks(), ['S1', 'S2']);
});

test('sold units drop out; their old address redirects', async () => {
  const slug = (await inv.getByGuid(B)).slug;
  const r = await sync(source([florence(A, 'S1', { Price: 3500 }), tusc]));
  assert.equal(r.removed, 1);
  assert.deepEqual(await stocks(), ['S1']);
  const res = await worker.fetch(new Request(`https://www.ridewithbyron.com/inventory/${slug}`), ENV, { waitUntil() {} });
  assert.equal(res.status, 301);
  assert.match(res.headers.get('Location'), /^\/inventory\?/);
});

test('bad reads change nothing: challenge, partial result, empty result, outage', async () => {
  let r = await sync(async (u) => ({ ok: false, status: 403, url: u, text: async () => '<title>Azure WAF</title>' }));
  assert.equal(r.status, 'blocked');
  await useDb(ENV.DB);
  assert.equal((await runSync({ trigger: 'schedule', fetchImpl: source([]) })).status, 'skipped', 'cool-down after a challenge');
  await setSetting('sync_blocked_until', null);
  assert.equal((await sync(source([tusc], 300))).status, 'failed', 'partial result refused');
  assert.equal((await sync(source([]))).status, 'failed', 'empty result refused');
  assert.equal((await sync(async () => { throw new Error('network down'); })).status, 'failed');
  assert.deepEqual(await stocks(), ['S1']);
});

test('a suspicious collapse in Florence inventory is refused', async () => {
  const many = Array.from({ length: 30 }, (_, i) => florence(`bbbbbbbb-0000-0000-0000-${String(i).padStart(12, '0')}`, `M${i}`));
  assert.equal((await sync(source(many))).status, 'success');
  assert.equal((await sync(source(many.slice(0, 5)))).status, 'failed');
  assert.equal((await inv.allPublic()).length, 30);
  assert.equal((await sync(source([florence(A, 'S1', { Price: 3500 }), ...many.slice(0, 14)]))).status, 'success', 'an ordinary decrease is fine');
});

test('stale data is flagged, then hidden; suspending sync stops runs', async () => {
  await q.run('UPDATE units SET last_verified=? WHERE guid=?', [new Date(Date.now() - 5 * 3600e3).toISOString(), A]);
  assert.equal((await inv.getByGuid(A)).stale, true);
  assert.ok((await stocks()).includes('S1'), 'still shown, marked for re-verification');
  await q.run('UPDATE units SET last_verified=? WHERE guid=?', [new Date(Date.now() - 30 * 3600e3).toISOString(), A]);
  assert.ok(!(await stocks()).includes('S1'), 'hidden after 24h unverified');
  await setSetting('sync_paused', true);
  assert.equal((await sync(source([florence(A, 'S1')]))).status, 'skipped');
  await setSetting('sync_paused', false);
  await sync(source([florence(A, 'S1', { Price: 3500 }), florence(C, 'S3', { Manufacturer: 'Polaris', ProductName: 'Ranger Crew XP 1000', ProductType: 'Utility Vehicles', Year: 2026, Price: 21999 })]));
  assert.deepEqual(await stocks(), ['S1', 'S3']);
});

test('admin "hidden" removes a unit from every public query; search handles hostile input', async () => {
  await q.run('UPDATE overrides SET hidden=1 WHERE guid=?', [A]);
  assert.deepEqual(await stocks(), ['S3']);
  assert.equal(await inv.isPublic(await inv.getByGuid(A)), false);
  await q.run('UPDATE overrides SET hidden=0 WHERE guid=?', [A]);
  const n = async (f) => (await inv.search(inv.parseFilters(f))).total;
  assert.equal(await n({}), 2);
  assert.equal(await n({ make: 'polaris' }), 1);
  assert.equal(await n({ make: 'Polaris', family: 'Ranger' }), 1);
  assert.equal(await n({ type: 'Side-by-Sides' }), 1);
  assert.equal(await n({ maxPrice: '5000' }), 1);
  assert.equal(await n({ q: "S3' OR 1=1 --" }), 0);
  assert.equal(await n({ q: 's3' }), 1);
  assert.equal(await n({ sort: 'DROP TABLE units', page: '-4', make: ['a', 'b'] }), 2);
  const f = await inv.facets();
  assert.equal(f.total, 2);
  assert.ok(f.polarisFamilies.some((x) => x.value === 'Ranger'));
  assert.ok(!(await inv.related(await inv.getByGuid(A))).some((u) => u.guid === A), 'a unit is never its own related unit');
});

test('lead validation, phone normalization and source attribution', () => {
  assert.equal(leads.normalizePhone('(256) 555-0142'), '+12565550142');
  assert.equal(leads.normalizePhone('555-0142'), null);
  assert.equal(leads.validateLead({ name: 'A', phone: '1', email: 'x' }).ok, false);
  assert.ok(leads.validateLead({ name: 'Pat Rider', phone: '2565550142' }).errors.consent, 'consent required');
  const s = leads.classifySource;
  assert.equal(s({ gclid: 'x' }), 'Google Ads');
  assert.equal(s({ utm_source: 'facebook', utm_medium: 'paid_social', fbclid: 'x' }), 'Facebook Ads');
  assert.equal(s({ referrer: 'https://www.facebook.com/marketplace/item/1' }), 'Facebook Marketplace');
  assert.equal(s({ utm_source: 'instagram' }), 'Instagram');
  assert.equal(s({ referrer: 'https://www.google.com/' }), 'Organic Google search');
  assert.equal(s({ referrer: 'https://www.somesite.com/page' }), 'Referral');
  assert.equal(s({}), 'Direct');
});

test('authorized-feed records require both location fields', () => {
  const rec = { ProductGuid: 'AAAAAAAA-1111-2222-3333-444444444444', Year: 2026, Manufacturer: 'Polaris', ModelName: 'Ranger 1000', StockNumber: 'P1', Price: '$15,999', DealershipId: F.toUpperCase(), DealershipName: 'Shoals Outdoor Sports - Florence' };
  assert.equal(classifyFeedUnit(mapFeedUnit(rec)).status, 'active');
  assert.equal(classifyFeedUnit(mapFeedUnit({ ...rec, DealershipId: TUSC_ID })).status, 'quarantined');
  assert.equal(classifyFeedUnit(mapFeedUnit({ ...rec, DealershipId: undefined })).status, 'quarantined');
  assert.equal(classifyFeedUnit(mapFeedUnit({ ...rec, DealershipName: undefined })).status, 'quarantined');
});

// ---------------- the Worker itself, request by request
const ctx = { waitUntil(p) { ctx.pending.push(p); }, pending: [] };
const call = async (path, init = {}) => worker.fetch(new Request('https://www.ridewithbyron.com' + path, { redirect: 'manual', ...init }), ENV, ctx);

test('public pages render with real units, security headers and correct indexing rules', async () => {
  for (const p of ['/', '/inventory', '/about', '/contact', '/financing', '/privacy', '/about-this-site', '/polaris-ranger-for-sale-florence-al', '/robots.txt', '/healthz']) {
    const r = await call(p);
    assert.equal(r.status, 200, p);
  }
  const home = await call('/');
  assert.match(home.headers.get('Content-Security-Policy'), /default-src 'self'/);
  assert.equal(home.headers.get('X-Frame-Options'), 'DENY');
  const body = await home.text();
  assert.match(body, /YOUR NEXT|Your next/i);
  assert.match(body, /Ranger Crew XP 1000/);
  const unit = await inv.getByGuid(C);
  const page = await (await call(unit.url)).text();
  assert.match(page, /"@type":\["Product","Vehicle"\]/);
  assert.match(page, /Stock #<\/dt><dd>S3/);
  assert.match(page, /rel="canonical" href="https:\/\/www\.ridewithbyron\.com\/inventory\//);
  assert.match(await (await call('/inventory?make=Polaris')).text(), /noindex,follow/);
  assert.doesNotMatch(await (await call('/inventory')).text(), /noindex/);
  const sm = await (await call('/sitemap.xml')).text();
  assert.ok(sm.includes(unit.url) && !sm.includes('/admin'));
  assert.equal((await call('/inventory/nope')).status, 404);
  assert.equal((await call('/nope')).status, 404);
  const preview = await worker.fetch(new Request('https://ridewithbyron.example.workers.dev/'), ENV, ctx);
  assert.match(preview.headers.get('X-Robots-Tag'), /noindex/);
  assert.equal((await worker.fetch(new Request('https://ridewithbyron.com/about?x=1', { redirect: 'manual' }), ENV, ctx)).status, 301, 'bare domain -> www');
});

test('lead form: spam controls, storage with vehicle + attribution, dedupe, Torque payload', async () => {
  const post = (b) => call('/lead', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'CF-Connecting-IP': '203.0.113.9' }, body: JSON.stringify(b) });
  const fresh = await sec.formToken();
  assert.equal((await post({ _t: fresh, name: 'Pat Rider', phone: '256-555-0142', consent: 'yes' })).status, 400, 'submitted too fast');
  assert.equal((await post({ _t: 'x.y', name: 'Pat Rider', phone: '256-555-0142', consent: 'yes' })).status, 400, 'forged token');
  const t = await sec.sign({ f: 1, t: Date.now() - 5000 }, 3600, 'form');
  assert.equal((await post({ _t: t, name: 'P', phone: '12', consent: 'yes' })).status, 422);
  assert.equal((await post({ _t: t, name: 'Bot', phone: '256-555-0142', consent: 'yes', company: 'x' })).status, 200, 'honeypot: quiet success');
  assert.equal((await q.get('SELECT COUNT(*) n FROM leads')).n, 0, 'nothing stored for bots or bad input');
  const good = { _t: t, name: 'Pat Rider', phone: '(256) 555-0142', email: 'PAT@Example.com', consent: 'yes', intent: 'quote', message: '<script>alert(1)</script>', unit: C, attribution: JSON.stringify({ gclid: 'abc', utm_campaign: 'rangers', evil: '<x>' }), page_url: '/inventory' };
  assert.equal((await post(good)).status, 200);
  assert.equal((await post(good)).status, 200);
  await Promise.all(ctx.pending);
  const rows = await q.all('SELECT * FROM leads');
  assert.equal(rows.length, 1, 'double submit collapsed');
  const l = rows[0];
  assert.deepEqual([l.stock_number, l.source, l.phone_e164, l.email, l.crm_status], ['S3', 'Google Ads', '+12565550142', 'pat@example.com', 'not_configured']);
  assert.equal(JSON.parse(l.attribution).evil, undefined);
  const p = leads.torquePayload(l);
  assert.deepEqual([p.contact.phone, p.vehicle.stock_number, p.assignment.assigned_to, p.attribution.source, p.follow_up_task.create], ['+12565550142', 'S3', 'Byron Green', 'Google Ads', true]);
  const form = await call('/lead', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '203.0.113.10' }, body: new URLSearchParams({ _t: t, name: 'Form User', phone: '2565550188', consent: 'yes', intent: 'visit', preferred_time: 'Sat AM' }) });
  assert.equal(form.status, 200, 'works without JavaScript');
  assert.match(await form.text(), /Message sent/);
});

test('Torque delivery: signed, retried on failure, marked delivered on success', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  initConfig({ ...ENV, TORQUE_WEBHOOK_URL: 'https://torque.example/api/leads', TORQUE_API_KEY: 'k', TORQUE_SIGNING_SECRET: 's' });
  try {
    globalThis.fetch = async () => new Response('nope', { status: 500 });
    await leads.runOutbox();
    let l = await q.get('SELECT crm_status, crm_attempts, crm_last_error FROM leads WHERE id=1');
    assert.deepEqual([l.crm_status, l.crm_attempts], ['pending', 1]);
    assert.match(l.crm_last_error, /500/);
    await q.run('UPDATE leads SET crm_next_attempt=NULL');
    // A web page answering "200 OK" (wrong address) is not a receipt.
    globalThis.fetch = async () => new Response('<!doctype html><title>Torque CRM</title>', { status: 200 });
    await leads.runOutbox();
    l = await q.get('SELECT crm_status, crm_attempts, crm_last_error FROM leads WHERE id=1');
    assert.deepEqual([l.crm_status, l.crm_attempts], ['pending', 2]);
    assert.match(l.crm_last_error, /did not confirm/);
    await q.run('UPDATE leads SET crm_next_attempt=NULL');
    globalThis.fetch = async (url, init) => { seen.push({ url, init }); return new Response(JSON.stringify({ id: 'T-77' }), { status: 200 }); };
    await leads.runOutbox();
    l = await q.get('SELECT crm_status, crm_ref FROM leads WHERE id=1');
    assert.deepEqual([l.crm_status, l.crm_ref], ['delivered', 'T-77']);
    const h = seen[0].init.headers;
    assert.equal(h.Authorization, 'Bearer k');
    assert.match(h['X-RWB-Signature'], /^sha256=[0-9a-f]{64}$/);
    assert.equal(h['Idempotency-Key'], 'rwb-lead-1');
    assert.equal(JSON.parse(seen[0].init.body).contact.phone, '+12565550142');
  } finally { globalThis.fetch = realFetch; initConfig(ENV); }
});

test('admin: sign-in, CSRF, overrides, pause switch, escaping', async () => {
  assert.equal((await call('/admin')).status, 303);
  const login = (pw, ip = '203.0.113.50') => call('/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': ip }, body: new URLSearchParams({ password: pw }) });
  assert.equal((await login('wrong')).status, 401);
  const ok = await login('correct horse battery staple');
  assert.equal(ok.status, 303);
  const cookie = ok.headers.get('Set-Cookie').split(';')[0];
  assert.match(ok.headers.get('Set-Cookie'), /HttpOnly; SameSite=Strict; Secure/);
  const get = (p) => call(p, { headers: { Cookie: cookie } });
  for (const p of ['/admin', '/admin/inventory', '/admin/leads', '/admin/traffic', '/admin/content', '/admin/logs', '/admin/leads.csv']) assert.equal((await get(p)).status, 200, p);
  const leadsPage = await (await get('/admin/leads')).text();
  assert.ok(leadsPage.includes('&lt;script&gt;alert(1)') && !leadsPage.includes('<script>alert(1)'), 'customer text is escaped');
  const csrf = (await (await get('/admin')).text()).match(/name="_csrf" value="([^"]+)"/)[1];
  const post = (p, b) => call(p, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(b) });
  assert.equal((await post('/admin/sync/pause', {})).status, 403, 'no CSRF token');
  assert.equal((await post('/admin/sync/pause', { _csrf: csrf })).status, 303);
  await useDb(ENV.DB);
  assert.equal(getSetting('sync_paused'), true);
  await post('/admin/sync/resume', { _csrf: csrf });
  await post(`/admin/unit/${C}`, { _csrf: csrf, hidden: '1' });
  assert.deepEqual(await stocks(), ['S1']);
  await post(`/admin/unit/${C}`, { _csrf: csrf, hidden: '0' });
  await post('/admin/content', { _csrf: csrf, byronPhone: '(256) 555-0100', showNoFees: '1', heroImage: 'javascript:alert(1)' });
  const home = await (await call('/')).text();
  assert.match(home, /href="tel:\+12565550100"/, 'one-tap call once the number is set');
  assert.ok(!home.includes('javascript:alert'));
  for (let i = 0; i < 9; i++) await login('wrong', '203.0.113.99');
  assert.equal((await login('correct horse battery staple', '203.0.113.99')).status, 429, 'sign-in is rate limited');
  assert.equal(await overLimit('x', 'y', 2, 60), false);
  initConfig({ ...ENV, ADMIN_PASSWORD: '' });
  assert.equal(await sec.passwordOk(''), false, 'no password set = nobody gets in');
  initConfig(ENV);
});

test('scheduled trigger runs without throwing when the source is unreachable', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try { await worker.scheduled({}, ENV, ctx); } finally { globalThis.fetch = realFetch; }
  await useDb(ENV.DB);
  assert.equal(getSetting('last_sync_attempt').status, 'failed');
  assert.deepEqual(await stocks(), ['S1', 'S3'], 'inventory untouched');
});

// ---------------- vehicle types and model details (specs from dealer unit pages)
import { vehicleType, family } from '../src/sync/taxonomy.js';
import { parseDetails, runDetails, detailsProgress } from '../src/sync/details.js';

test('vehicle types come out right for the category/subtype pairs the live inventory really has', () => {
  const t = (category, modelType, make = 'Polaris', model = '') => vehicleType({ category, modelType, make, model });
  assert.equal(t('Utility Vehicles', 'Regular Cab'), 'Side-by-Sides');
  assert.equal(t('Utility Vehicles', 'Crew Cab'), 'Side-by-Sides');
  assert.equal(t('Utility Vehicles', 'RZR XP 4'), 'Side-by-Sides');
  assert.equal(t('Utility Vehicles', 'Youth'), 'Side-by-Sides');
  assert.equal(t('ATVs', 'ATV: Full-Size Utility'), 'ATVs');
  assert.equal(t('ATVs', 'Youth'), 'ATVs');
  assert.equal(t('Utility Vehicles', 'ATV: Youth', 'TRACKER', 'TRACKER 90 ATV'), 'ATVs', 'the subtype settles a mislabelled category');
  assert.equal(t('Power Boats Outboard', 'Pontoon Boats', 'Bennington'), 'Pontoons');
  assert.equal(t('Power Boats Outboard', 'Bass Boats', 'Nitro'), 'Boats');
  assert.equal(t('Power Boats Inboard', 'Runabouts', 'Larson'), 'Boats');
  assert.equal(t('Boat Engines', 'FourStroke 60-115', 'Mercury Marine'), 'Outboard Motors');
  assert.equal(t('Trailers', 'Utility Trailers', 'GREY STATES'), 'Trailers');
  assert.equal(t('Lawn Mowers - Riding', 'ZERO TURN UNDER $5K', 'Cub Cadet'), 'Mowers');
  assert.equal(t('Motorcycles', 'Motocross', 'Honda'), 'Motorcycles');
  assert.equal(t('Something New', 'Whatever'), 'Other', 'a raw subtype is never shown as a shopping category');
  assert.equal(family({ make: 'Polaris', model: 'RZR 200 EFI', modelType: 'Youth' }), 'Youth');
  assert.equal(family({ make: 'Polaris', model: 'Ranger Crew 1000', modelType: 'Crew Cab' }), 'Ranger');
  assert.equal(family({ make: 'Polaris', model: 'Polaris XPEDITION ADV 5 NorthStar', modelType: 'XPEDITION CREW CAB' }), 'XPEDITION');
  assert.equal(family({ make: 'Kawasaki', model: 'Teryx4 LE', modelType: 'Crew Cab' }), null);
  // The record shape the search really returns: broad group in ProductCategory, subtype in ProductType.
  const u = mapHit(florence(A, 'S1', { Manufacturer: 'Polaris', ProductName: 'Ranger Crew 1000', ProductCategory: 'Utility Vehicles', ProductType: 'Crew Cab' }));
  assert.deepEqual([u.category, u.modelType, vehicleType(u)], ['Utility Vehicles', 'Crew Cab', 'Side-by-Sides']);
});

test('dealer unit pages are read accurately for specs, features and description', () => {
  const r = parseDetails(fx('unit-page-ranger.html'));
  assert.deepEqual(r.specs.map((g) => g.group), ['General Information', 'Brakes/Wheels/Tires', 'Dimensions', 'Drivetrain', 'Electrical', 'Engine', 'Operational', 'Other']);
  assert.deepEqual(r.features.map((g) => [g.group, g.items.length]), [['Capability', 6], ['Comfort', 6], ['Durability', 6], ['Upgrade To Northstar Ultimate', 3]]);
  assert.deepEqual([r.keySpecs.seats, r.keySpecs.horsepower, r.keySpecs.displacement, r.keySpecs.groundClearance], [6, '82 hp', '999 cc', '14 in. (36 cm)']);
  assert.match(r.description, /^Delivers more power/);
  assert.ok(r.specs.flatMap((g) => g.rows).every(([k, v]) => k && v && !/[<>]/.test(k + v)), 'no markup leaks into values');
  const p = parseDetails(fx('unit-page-pontoon.html'));
  assert.equal(p.features.length, 0);
  assert.equal(p.keySpecs.seats, null, 'a spec the page does not state stays empty');
  assert.match(p.description, /MERCURY 60 ELPT/);
  assert.deepEqual(parseDetails('<html><body>nothing here</body></html>'), { ...parseDetails(''), });
  assert.equal(parseDetails('').specs.length, 0);
});

test('model details: one page per model, shared across its units; a dealer note stays on its own unit; a challenge stops the job', async () => {
  await q.run('DELETE FROM units'); await q.run('DELETE FROM overrides'); await q.run('DELETE FROM model_details');
  const R1 = 'cccccccc-0000-0000-0000-000000000001', R2 = 'cccccccc-0000-0000-0000-000000000002', P1 = 'dddddddd-0000-0000-0000-000000000001', P2 = 'dddddddd-0000-0000-0000-000000000002';
  const ranger = (id, stock) => florence(id, stock, { Year: 2026, Manufacturer: 'Polaris', ProductName: 'Ranger Crew XP 1000 NorthStar Edition Ultimate', ProductCategory: 'Utility Vehicles', ProductType: 'Crew Cab', ShowroomUrl: `https://www.shoalsoutdoorsportsflorence.com/dx1inventory/${id}` });
  const pontoon = (id, stock) => florence(id, stock, { Year: 2026, Manufacturer: 'Bennington', ProductName: '20 S 4PT FISHING', ProductCategory: 'Power Boats Outboard', ProductType: 'Pontoon Boats', ShowroomUrl: `https://www.shoalsoutdoorsportsflorence.com/dx1inventory/${id}` });
  assert.equal((await sync(source([ranger(R1, 'R1'), ranger(R2, 'R2'), pontoon(P1, 'P1'), pontoon(P2, 'P2')]))).status, 'success');
  assert.equal((await inv.search(inv.parseFilters({ seats: '6' }))).total, 0, 'no specs yet');
  assert.deepEqual(await detailsProgress(), { models: 2, have: 0, blockedUntil: null });

  const calls = [];
  const pages = async (u) => { calls.push(u); return { status: 200, text: async () => (/cccccccc/.test(u) ? fx('unit-page-ranger.html') : fx('unit-page-pontoon.html')) }; };
  const r = await runDetails({ max: 5, fetchImpl: pages, pauseMs: 0 });
  assert.deepEqual([r.status, r.done], ['ok', 2]);
  assert.equal(calls.length, 2, 'two models, two page reads — not four');
  assert.equal((await runDetails({ max: 5, fetchImpl: pages, pauseMs: 0 })).tried, 0, 'nothing is fetched twice');

  const [a, b] = [await inv.getByGuid(R1), await inv.getByGuid(R2)];
  for (const u of [a, b]) {
    assert.equal(u.seats, 6);
    assert.equal(u.data.keySpecs.horsepower, '82 hp');
    assert.equal(u.data.specs.length, 8);
    assert.match(u.data.description, /^Delivers more power/, 'the manufacturer description is shared by the model');
  }
  assert.equal((await inv.search(inv.parseFilters({ seats: '6' }))).total, 2, 'seating filter now works');
  assert.ok((await inv.facets()).seats.some((s) => s.value === 6 && s.n === 2));
  const fetchedGuid = calls.find((u) => /dddddddd/.test(u)).match(/[0-9a-f-]{36}/)[0];
  const [own, other] = [await inv.getByGuid(fetchedGuid), await inv.getByGuid(fetchedGuid === P1 ? P2 : P1)];
  assert.match(own.data.description, /MERCURY 60 ELPT/);
  assert.equal(other.data.description, null, 'one boat’s motor-and-trailer note is not copied onto another boat');
  assert.equal(other.data.specs.length, 4, 'but the model’s specs are');
  const html = await (await call(a.url)).text();
  assert.match(html, /<h2>Specifications<\/h2>/);
  assert.match(html, /82 hp/);
  assert.match(html, /<li>6 seats<\/li>|Seating<\/dt><dd>6/);

  // a new model arrives; the site answers with a challenge -> stop, and stay stopped
  await sync(source([ranger(R1, 'R1'), ranger(R2, 'R2'), pontoon(P1, 'P1'), pontoon(P2, 'P2'), florence(C, 'S3', { Year: 2025, Manufacturer: 'Polaris', ProductName: 'RZR XP 1000', ShowroomUrl: `https://www.shoalsoutdoorsportsflorence.com/dx1inventory/${C}` })]));
  const blocked = await runDetails({ max: 5, pauseMs: 0, fetchImpl: async () => ({ status: 403, text: async () => '<title>Azure WAF</title>' }) });
  assert.equal(blocked.status, 'blocked');
  await useDb(ENV.DB);
  assert.equal((await runDetails({ max: 5, pauseMs: 0, fetchImpl: pages })).status, 'skipped');
  await setSetting('details_blocked_until', null);
  // a page that fails is retried later, not hammered; a foreign address is never fetched
  let n = 0;
  await runDetails({ max: 5, pauseMs: 0, fetchImpl: async () => { n++; return { status: 500, text: async () => 'oops' }; } });
  await runDetails({ max: 5, pauseMs: 0, fetchImpl: async () => { n++; return { status: 500, text: async () => 'oops' }; } });
  assert.equal(n, 1, 'a failed page waits a day before the next try');
  await q.run("UPDATE units SET source_url='https://evil.example/x' WHERE guid=?", [C]);
  await q.run('DELETE FROM model_details WHERE ok=0');
  n = 0;
  await runDetails({ max: 5, pauseMs: 0, fetchImpl: async () => { n++; return { status: 200, text: async () => '' }; } });
  assert.equal(n, 0);
});

test('the dealer page is not re-read while its search key is still good; a refused key is replaced once', async () => {
  await q.run('DELETE FROM units'); await setSetting('sync_blocked_until', null);
  const key = (mins) => btoa(`${'0'.repeat(64)}validUntil=${Math.floor(Date.now() / 1000) + mins * 60}`);
  const page = (mins) => PAGE.replace(/"apiKey":"[^"]+"/, `"apiKey":"${key(mins)}"`);
  const calls = { page: 0, search: 0 };
  const src = (mins, searchOk = () => true) => async (u) => {
    if (String(u).includes('algolia.net')) { calls.search++; return searchOk() ? { ok: true, status: 200, json: async () => ({ hits: [florence(A, 'S1')], nbHits: 1, nbPages: 1 }) } : { ok: false, status: 403, json: async () => ({}) }; }
    calls.page++; return { ok: true, status: 200, url: u, text: async () => page(mins) };
  };
  await setSetting('search_config', null);
  assert.equal((await sync(src(60))).status, 'success');
  assert.equal(calls.page, 1);
  assert.equal((await sync(src(60))).status, 'success');
  assert.equal(calls.page, 1, 'second sync reused the key');
  let first = true;
  assert.equal((await sync(src(60, () => { const ok = !first; first = false; return ok; }))).status, 'success');
  assert.equal(calls.page, 2, 'a refused key is fetched again, once');
  await setSetting('search_config', { ...(await q.get("SELECT value FROM settings WHERE key='search_config'")) && JSON.parse((await q.get("SELECT value FROM settings WHERE key='search_config'")).value), validUntil: Math.floor(Date.now() / 1000) + 60 });
  await sync(src(60));
  assert.equal(calls.page, 3, 'a key about to expire is replaced');
});

// ---------------- community page
import * as community from '../src/community/store.js';
import { foulWord, screenPost, hideContacts, youtubeId, aiHoldReason } from '../src/community/moderate.js';

test('foul-language filter: catches disguises, leaves ordinary riding talk alone', () => {
  for (const t of ['what the fuck', 'F U C K this', 'f.u.c.k', 'sh1t trail', 'shiiiit', 'b!tch', 'a$$hole', 'you are an ass', 'damn that was fun', 'f*ck', 'phuck', 'dumb@ss', 'kiss my a s s', 'pissed off', 'wtf man', 'fück', 'f_u_c_k', 'asses']) assert.ok(foulWord(t), `should refuse: ${t}`);
  for (const t of ['First class hit on the Ranger', 'Great pass through the grass', 'I assume the Bass Pro trail is open', 'Check the cockpit on that RZR', 'Dickson County trails', 'assess the damage', 'This hits different', 'Cumberland Plateau ride Saturday', 'spicy wings after', 'S O S if you get stuck', 'R Z R 1000', 'meet @ 5 at the gas station', 'a s a p', 'Polaris RZR-200', 'F-150 pulls it fine', 'wash it off', '2 seats, 4 wheels, 82 hp']) assert.equal(foulWord(t), null, `should allow: ${t}`);
  assert.equal(hideContacts('call 256-555-2964 or me@x.com, 2026 Ranger 1000'), 'call [phone hidden] or [email hidden], 2026 Ranger 1000');
  assert.equal(screenPost({ author: 'Byron', body: 'hello there', isTopic: false }).ok, false, 'nobody can pose as Byron');
  assert.equal(screenPost({ author: 'Tim', title: 'Trails', body: 'see http://spam.example', isTopic: true }).hold, 'Contains a link');
  assert.equal(screenPost({ author: 'sh1thead', body: 'hello there', isTopic: false }).ok, false, 'names are filtered too');
  assert.equal(youtubeId('https://youtu.be/dQw4w9WgXcQ?si=x'), 'dQw4w9WgXcQ');
  assert.equal(youtubeId('https://evil.example/watch?v=dQw4w9WgXcQ'), null);
});

test('AI safety check: holds what it flags, never blocks when it is missing or broken', async () => {
  assert.equal(await aiHoldReason(null, 'hi'), null);
  assert.equal(await aiHoldReason({ run: async () => ({ response: 'safe' }) }, 'hi'), null);
  assert.match(await aiHoldReason({ run: async () => ({ response: 'unsafe\nS10' }) }, 'x'), /AI flagged/);
  assert.match(await aiHoldReason({ run: async () => ({ response: { safe: false, categories: ['S10'] } }) }, 'x'), /S10/);
  assert.equal(await aiHoldReason({ run: async () => { throw new Error('down'); } }, 'x'), null);
});

test('community: the whole life of a post, with no account', async () => {
  const tok = async () => sec.sign({ f: 1, t: Date.now() - 5000 }, 3600, 'form');
  let ipn = 20;
  const post = async (fields, cookie = '', ip = `198.51.100.${++ipn}`) => call('/community/post', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': ip, ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams({ _t: await tok(), ...fields }) });
  const cookieOf = (res) => (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('Set-Cookie')]).map((c) => c.split(';')[0]).join('; ');
  const page = async (p = '/community') => (await call(p)).text();

  // empty page: placeholder video invitation, no topics, rules shown
  let h = await page();
  assert.match(h, /Your ride could be first/);
  assert.match(h, /No topics yet/);
  assert.match(h, /House rules/);
  assert.match(h, /href="\/community"[^>]*>Community</, 'in the site menu');

  // foul language is refused and nothing is saved
  let r = await post({ author: 'Mud Dog', title: 'Best trails', body: 'This sh1t is awesome' });
  assert.equal(r.status, 422);
  assert.match(await r.text(), /Keep it clean/);
  assert.equal((await q.get('SELECT COUNT(*) n FROM community_posts')).n, 0);
  // bots (honeypot) get a quiet thank-you and nothing is saved; a missing form token is refused
  assert.equal((await post({ author: 'Bot', title: 'Buy now', body: 'cheap stuff', company: 'x' })).status, 303);
  assert.equal((await call('/community/post', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ author: 'A B', title: 'Hello there', body: 'hi all' }) })).status, 400);
  assert.equal((await q.get('SELECT COUNT(*) n FROM community_posts')).n, 0);

  // a person's first post waits for Byron
  r = await post({ author: 'Mud Dog', title: 'Favorite spots around the Shoals', body: 'Where do y’all ride? Text me at 256-555-2964 <script>alert(1)</script>' });
  assert.equal(r.status, 303);
  assert.match(r.headers.get('Location'), /m=held/);
  const mudDog = cookieOf(r);
  assert.match(mudDog, /rwb_c=/);
  assert.doesNotMatch(await page(), /Favorite spots around the Shoals/, 'held posts are not public');
  const held = await q.get("SELECT * FROM community_posts WHERE status='held'");
  assert.equal(held.hold_reason, 'First post from this person');
  assert.match(held.body, /\[phone hidden\]/);
  await community.moderate(held.id, 'approve');
  h = await page();
  assert.match(h, /Favorite spots around the Shoals/);
  h = await page(`/community/t/${held.id}`);
  assert.ok(h.includes('&lt;script&gt;alert(1)') && !h.includes('<script>alert(1)'), 'visitor text is escaped');
  assert.match(h, /DiscussionForumPosting/);

  // once approved, that person's posts go straight up; a different person's reply is held
  r = await post({ author: 'Mud Dog', parent: String(held.id), body: 'Bankhead is my favorite so far.' }, mudDog);
  assert.match(r.headers.get('Location'), new RegExp(`/community/t/${held.id}\\?m=posted`));
  const reply1 = (await q.get("SELECT id FROM community_posts WHERE body LIKE 'Bankhead%'")).id;
  r = await post({ author: 'Trail Rat', parent: String(reply1), body: 'Stony Lonesome is worth the drive too.' });
  assert.match(r.headers.get('Location'), /m=held/);
  const rat = cookieOf(r);
  const ratPost = await q.get("SELECT id FROM community_posts WHERE author='Trail Rat'");
  await community.moderate(ratPost.id, 'approve');
  h = await page(`/community/t/${held.id}`);
  assert.ok(h.indexOf('Bankhead') < h.indexOf('Stony Lonesome'));
  assert.match(h, /class="c-children"/, 'replies nest under what they answer');
  assert.match(await page(), /2 replies/);

  // links wait for Byron even from a known poster; the same words twice are refused
  r = await post({ author: 'Mud Dog', parent: String(held.id), body: 'Map is at trailmaps.com/bankhead' }, mudDog);
  assert.match(r.headers.get('Location'), /m=heldlink/);
  r = await post({ author: 'Mud Dog', parent: String(held.id), body: 'Map is at trailmaps.com/bankhead' }, mudDog);
  assert.equal(r.status, 422);

  // the AI check holds a hostile post that has no banned words
  const realAI = ENV.AI;
  ENV.AI = { run: async (_m, input) => ({ response: /idiot/.test(input.messages[0].content) ? 'unsafe\nS10' : 'safe' }) };
  r = await post({ author: 'Trail Rat', parent: String(held.id), body: 'Only an idiot rides there.' }, rat);
  assert.match(r.headers.get('Location'), /m=heldreview/);
  assert.match((await q.get("SELECT hold_reason FROM community_posts WHERE body LIKE 'Only an idiot%'")).hold_reason, /AI flagged/);
  ENV.AI = realAI;

  // three different people reporting a post hides it; one person reporting three times does not
  const report = async (id, cookie, ip) => call('/community/report', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': ip, ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams({ _t: await tok(), id: String(id) }) });
  const one = cookieOf(await report(ratPost.id, '', '203.0.113.1'));
  await report(ratPost.id, one, '203.0.113.1'); await report(ratPost.id, one, '203.0.113.1');
  assert.equal((await q.get('SELECT status FROM community_posts WHERE id=?', [ratPost.id])).status, 'live');
  await report(ratPost.id, '', '203.0.113.2'); await report(ratPost.id, '', '203.0.113.3');
  assert.equal((await q.get('SELECT status, hold_reason FROM community_posts WHERE id=?', [ratPost.id])).status, 'held');
  assert.doesNotMatch(await page(`/community/t/${held.id}`), /Stony Lonesome/);

  // Byron: closes a topic, blocks a poster (their posts come down and they can't post again)
  await community.moderate(held.id, 'lock');
  r = await post({ author: 'Mud Dog', parent: String(held.id), body: 'One more thing about Bankhead trails.' }, mudDog);
  assert.match(await r.text(), /closed to new replies/);
  await community.moderate(held.id, 'unlock');
  await community.moderate(ratPost.id, 'block');
  r = await post({ author: 'Trail Rat', parent: String(held.id), body: 'I am back again friends.' }, rat, '198.51.100.250');
  assert.match(await r.text(), /turned off for you/);
  assert.equal((await q.get("SELECT COUNT(*) n FROM community_posts WHERE author='Trail Rat' AND status='live'")).n, 0);

  // posting too fast is slowed down
  let last;
  for (let i = 0; i < 7; i++) last = await post({ author: 'Speedy', title: `Topic number ${i} here`, body: `Message number ${i} for the board` }, '', '198.51.100.99');
  assert.equal(last.status, 429);
});

test('community: Byron posts with a badge; videos; sent-in videos; admin tab', async () => {
  const login = await call('/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '203.0.113.77' }, body: new URLSearchParams({ password: 'correct horse battery staple' }) });
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  const tok = await sec.sign({ f: 1, t: Date.now() - 5000 }, 3600, 'form');
  let r = await call('/community/post', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie }, body: new URLSearchParams({ _t: tok, title: 'Welcome, riders', body: 'Glad you are here.' }) });
  assert.match(r.headers.get('Location'), /m=posted/);
  const mine = await q.get("SELECT * FROM community_posts WHERE title='Welcome, riders'");
  assert.deepEqual([mine.author, mine.staff, mine.status], ['Byron Green', 1, 'live']);
  assert.match(await (await call(`/community/t/${mine.id}`)).text(), /c-staff/);

  const adminPage = await (await call('/admin/community', { headers: { Cookie: cookie } })).text();
  const csrf = adminPage.match(/name="_csrf" value="([^"]+)"/)[1];
  const apost = (p, b) => call(p, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, ...b }) });
  assert.equal((await call('/admin/community')).status, 303, 'admin tab needs sign-in');
  assert.equal((await apost('/admin/community/video', { url: 'not a link' })).status, 303);
  assert.equal((await q.get('SELECT COUNT(*) n FROM community_videos')).n, 0);
  await apost('/admin/community/video', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Mud run <b>', credit: 'Pat' });
  let h = await (await call('/community')).text();
  assert.match(h, /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);
  assert.ok(h.includes('Mud run &lt;b&gt;') && !h.includes('Your ride could be first'));
  assert.match((await call('/community')).headers.get('Content-Security-Policy'), /frame-src https:\/\/www\.youtube-nocookie\.com/);
  const vid = (await q.get('SELECT id FROM community_videos')).id;
  await apost(`/admin/community/video/${vid}`, {});
  assert.equal((await q.get('SELECT COUNT(*) n FROM community_videos')).n, 0);

  // a rider sends in a video: needs a real link, a contact and the permission box
  const send = (b) => call('/community/video', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '198.51.100.200' }, body: new URLSearchParams({ _t: tok, ...b }) });
  assert.equal((await send({ name: 'Pat', url: 'javascript:alert(1)', contact: '256-555-2964', consent: 'yes' })).status, 422);
  assert.equal((await send({ name: 'Pat', url: 'https://youtu.be/dQw4w9WgXcQ', contact: '256-555-2964' })).status, 422, 'permission box required');
  r = await send({ name: 'Pat', url: 'https://youtu.be/dQw4w9WgXcQ', contact: '256-555-2964', note: 'Bankhead', consent: 'yes' });
  assert.match(r.headers.get('Location'), /m=sent/);
  h = await (await call('/admin/community', { headers: { Cookie: cookie } })).text();
  assert.match(h, /https:\/\/youtu\.be\/dQw4w9WgXcQ/);
  assert.doesNotMatch(await (await call('/community')).text(), /256-555-2964/, 'a sender’s contact is never public');

  // admin actions through the page: remove a topic
  await apost(`/admin/community/post/${mine.id}`, { action: 'remove' });
  assert.equal((await call(`/community/t/${mine.id}`)).status, 404);
  assert.match(await (await call('/sitemap.xml')).text(), /\/community</);
});

test('community: Byron gets one text for things that need him, not a flood', async () => {
  const realFetch = globalThis.fetch;
  const sent = [];
  initConfig({ ...ENV, TORQUE_WEBHOOK_URL: 'https://torque.example/leads/intake', TORQUE_SIGNING_SECRET: 's' });
  await setSetting('community_last_alert', null);
  try {
    const f = async (url, init) => { sent.push({ url, init }); return new Response('{"ok":true}', { status: 200 }); };
    assert.equal(await community.alertByron('A post is waiting.', f), true);
    assert.equal(await community.alertByron('Another one.', f), false, 'at most one text every 15 minutes');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'https://torque.example/leads/alert');
    assert.match(sent[0].init.headers['X-RWB-Signature'], /^sha256=[0-9a-f]{64}$/);
    assert.match(JSON.parse(sent[0].init.body).text, /^RideWithByron community: A post is waiting\./);
  } finally { globalThis.fetch = realFetch; initConfig(ENV); }
});
