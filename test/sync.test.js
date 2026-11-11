'use strict';
// Run with: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rwb-test-')), 'test.sqlite');
process.env.SYNC_REQUEST_DELAY_MS = '0';
process.env.SYNC_CHALLENGE_BACKOFF_MS = '0';
process.env.SESSION_SECRET = 'test-secret';
process.env.SYNC_ENABLED = 'false';
delete process.env.INVENTORY_FEED_URL;

const config = require('../src/config');
const { parseSitemap, parseUnitPage, classifyUnit, isChallengePage } = require('../src/sync/parse');
const { runSync } = require('../src/sync/engine');
const { db, setSetting } = require('../src/db');
const inv = require('../src/inventory');
const leads = require('../src/leads');
const { mapFeedUnit, classifyFeedUnit } = require('../src/sync/feed');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const G = { florence: 'bb5079e9-87fe-45f7-a291-b2dd00ee2b2b', tusc: '2d96b521-8a94-47d2-89a8-b4f10114b638', catalog: '609315ed-8d11-4404-9ed5-b48f00908182', usedTusc: '3b731697-7ae8-4e87-81f2-b4fa012c1ae7' };
const FLORENCE = fx('florence-instock-boat.html');
const TUSC = fx('tuscumbia-instock-ranger.html');
const CATALOG = fx('catalog-rzr.html');
const url = (g) => `${config.source.baseUrl}/Some-Unit-2026-Florence-AL-${g}`;

test('sitemap parser extracts unit pages keyed by stable GUID', () => {
  const entries = parseSitemap(fx('florence-sitemap.xml'));
  assert.ok(entries.length > 500);
  assert.ok(entries.every((e) => /^[0-9a-f-]{36}$/.test(e.guid)));
  assert.equal(new Set(entries.map((e) => e.guid)).size, entries.length, 'no duplicates');
  assert.throws(() => parseSitemap('<html>challenge</html>'));
});

test('real Florence in-stock page is parsed accurately and classified active', () => {
  const u = parseUnitPage(FLORENCE, url(G.florence));
  assert.equal(u.title, '2024 Hurricane SS205-OB');
  assert.equal(u.stockNumber, 'H902');
  assert.equal(u.price, 45990);
  assert.equal(u.msrp, 69520);
  assert.equal(u.onSale, true);
  assert.equal(u.evidence.locationName, 'Shoals Outdoor Sports - Florence');
  assert.deepEqual(u.evidence.imageDealershipIds, [config.source.florenceDealershipId]);
  assert.ok(u.images.length >= 1 && u.images.every((i) => i.startsWith('https://cdpcdn.dx1app.com/')));
  assert.equal(classifyUnit(u, config.source).status, 'active');
});

test('units at other locations are excluded even though the URL slug could say anything', () => {
  // Requested under a "Florence-AL" URL on purpose: the slug must never be trusted.
  const u = parseUnitPage(TUSC, url(G.tusc));
  assert.equal(u.evidence.locationName, 'Shoals Outdoor Sports - Tuscumbia');
  assert.equal(classifyUnit(u, config.source).status, 'other_location');
  assert.equal(u.price, null, '"Get Price" units have no fabricated price');
});

test('manufacturer catalog pages are not treated as stocked inventory', () => {
  const u = parseUnitPage(CATALOG, url(G.catalog));
  assert.equal(u.stockNumber, null);
  assert.equal(u.price, null, 'MSRP is not presented as an advertised price');
  assert.equal(u.msrp, 47999);
  assert.equal(classifyUnit(u, config.source).status, 'catalog');
});

test('conflicting or missing location evidence is quarantined', () => {
  const base = parseUnitPage(FLORENCE, url(G.florence));
  const c = (ev, extra = {}) => classifyUnit({ ...base, ...extra, evidence: { ...base.evidence, ...ev } }, config.source);
  assert.equal(c({ imageDealershipIds: ['06fcbe5c-a659-49e3-93ff-b006014cc892'] }).status, 'quarantined', 'name says Florence, photos say another store');
  assert.equal(c({ locationName: null }).status, 'quarantined', 'no location field');
  assert.equal(c({ locationName: 'Shoals Outdoor Sports - Tuscumbia' }).status, 'quarantined', 'name says Tuscumbia, photos say Florence');
  assert.equal(c({ locationName: 'Shoals Outdoor Sports - Tuscumbia', imageDealershipIds: [] }).status, 'other_location');
  assert.equal(c({ locationName: 'Florence Powersports' }).status, 'quarantined', 'look-alike name with Florence photo id is a conflict');
  assert.equal(c({ locationName: 'Florence Powersports', imageDealershipIds: [] }).status, 'other_location', 'near-match names never pass');
  assert.equal(c({ availabilityText: 'Sold' }).status, 'unavailable');
  assert.equal(c({}, { stockNumber: null }).status, 'quarantined');
});

test('anti-bot challenge pages are recognized', () => {
  assert.equal(isChallengePage(403, '<title>Azure WAF</title>'), true);
  assert.equal(isChallengePage(200, '<meta name="description" content="Azure WAF JS Challenge"/>'), true);
  assert.equal(isChallengePage(200, FLORENCE), false);
});

// ---- engine, against a scripted fake source
function fakeSource(routes) {
  const calls = [];
  const impl = async (u) => {
    calls.push(u);
    const r = routes[u] || routes[Object.keys(routes).find((k) => u.endsWith(k))];
    const { status = 200, body = '', final } = typeof r === 'function' ? r() : r || { status: 404, body: 'nf' };
    return { status, ok: status === 200, url: final || u, text: async () => body };
  };
  impl.calls = calls;
  return impl;
}
const sitemap = (guids) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${guids.map((g) => `<url><loc>${url(g)}</loc></url>`).join('')}</urlset>`;
const SM = config.source.baseUrl + '/sitemap.xml';
const publicGuids = () => inv.allPublic().map((u) => u.guid);

test('sync lists only verified Florence units; others never become public', async () => {
  const r = await runSync({ trigger: 'test', fetchImpl: fakeSource({ [SM]: { body: sitemap([G.florence, G.tusc, G.catalog]) }, [G.florence]: { body: FLORENCE }, [G.tusc]: { body: TUSC }, [G.catalog]: { body: CATALOG } }) });
  assert.equal(r.status, 'success');
  assert.equal(r.added, 1);
  assert.deepEqual(publicGuids(), [G.florence]);
  const st = Object.fromEntries(db.prepare('SELECT guid,status FROM units').all().map((x) => [x.guid, x.status]));
  assert.equal(st[G.tusc], 'other_location');
  assert.equal(st[G.catalog], 'catalog');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM units').get().n, 3, 'no duplicates');
});

test('price changes are picked up and logged; admin overrides survive a sync', async () => {
  db.prepare("INSERT INTO overrides(guid,featured,note) VALUES(?,1,'Great boat')").run(G.florence);
  const cheaper = FLORENCE.replace('<h3 class="price">$45,990</h3>', '<h3 class="price">$44,490</h3>');
  const r = await runSync({ trigger: 'test', fetchImpl: fakeSource({ [SM]: { body: sitemap([G.florence, G.tusc, G.catalog]) }, [G.florence]: { body: cheaper } }) });
  assert.equal(r.price_changes, 1);
  const u = inv.getByGuid(G.florence);
  assert.equal(u.price, 44490);
  assert.equal(u.featured, 1);
  assert.equal(u.note, 'Great boat');
});

test('a unit transferred to another location disappears on the next sync', async () => {
  const moved = FLORENCE.replace('<span class="location">Shoals Outdoor Sports - Florence</span>', '<span class="location">Shoals Outdoor Sports - Tuscumbia</span>');
  const r = await runSync({ trigger: 'test', fetchImpl: fakeSource({ [SM]: { body: sitemap([G.florence]) }, [G.florence]: { body: moved } }) });
  assert.equal(r.quarantined, 1, 'name/photo-id conflict => quarantine');
  assert.deepEqual(publicGuids(), []);
  await runSync({ trigger: 'test', fetchImpl: fakeSource({ [SM]: { body: sitemap([G.florence]) }, [G.florence]: { body: FLORENCE } }) });
  assert.deepEqual(publicGuids(), [G.florence], 'returns once verified again');
});

test('temporary source failure keeps verified data, then stale units are hidden', async () => {
  const before = inv.getByGuid(G.florence).last_verified;
  const r = await runSync({ trigger: 'test', fetchImpl: fakeSource({ [SM]: { body: sitemap([G.florence]) }, [G.florence]: { status: 503, body: 'down' } }) });
  assert.equal(r.status, 'partial');
  assert.equal(inv.getByGuid(G.florence).last_verified, before, 'failure must not refresh the verified timestamp');
  assert.deepEqual(publicGuids(), [G.florence], 'still shown within the grace period');
  db.prepare('UPDATE units SET last_verified=? WHERE guid=?').run(new Date(Date.now() - 5 * 3600e3).toISOString(), G.florence);
  assert.equal(inv.getByGuid(G.florence).stale, true, 'marked stale after a few hours');
  db.prepare('UPDATE units SET last_verified=? WHERE guid=?').run(new Date(Date.now() - 30 * 3600e3).toISOString(), G.florence);
  assert.deepEqual(publicGuids(), [], 'hidden once unverified for 24h');
  await runSync({ trigger: 'test', fetchImpl: fakeSource({ [SM]: { body: sitemap([G.florence]) }, [G.florence]: { body: FLORENCE } }) });
  assert.deepEqual(publicGuids(), [G.florence]);
});

test('anti-bot challenge stops the run without touching inventory and starts a cool-down', async () => {
  const src = fakeSource({ [SM]: { body: sitemap([G.florence]) }, [G.florence]: { status: 403, body: '<title>Azure WAF</title>' } });
  const r = await runSync({ trigger: 'test', fetchImpl: src });
  assert.equal(r.status, 'blocked');
  assert.deepEqual(publicGuids(), [G.florence]);
  const skipped = await runSync({ trigger: 'schedule', fetchImpl: src });
  assert.equal(skipped.status, 'skipped');
  setSetting('sync_blocked_until', null);
});

test('suspending sync prevents runs', async () => {
  setSetting('sync_paused', true);
  const src = fakeSource({});
  assert.equal((await runSync({ trigger: 'schedule', fetchImpl: src })).status, 'skipped');
  assert.equal(src.calls.length, 0);
  setSetting('sync_paused', false);
});

test('a suspiciously shrunken sitemap is refused', async () => {
  setSetting('last_sitemap_count', 800);
  const r = await runSync({ trigger: 'test', fetchImpl: fakeSource({ [SM]: { body: sitemap([G.florence]) } }) });
  assert.equal(r.status, 'failed');
  setSetting('last_sitemap_count', 1);
});

test('sold/removed units are hidden (404 or page no longer in stock)', async () => {
  const sold = FLORENCE.replace('Availability: In Stock', 'Availability: Sold');
  await runSync({ trigger: 'test', fetchImpl: fakeSource({ [SM]: { body: sitemap([G.florence]) }, [G.florence]: { body: sold } }) });
  assert.deepEqual(publicGuids(), []);
  assert.equal(inv.getByGuid(G.florence).status, 'unavailable');
  await runSync({ trigger: 'test', fetchImpl: fakeSource({ [SM]: { body: sitemap([G.florence]) }, [G.florence]: { body: FLORENCE } }) });
  assert.deepEqual(publicGuids(), [G.florence]);
  const r = await runSync({ trigger: 'test', fetchImpl: fakeSource({ [SM]: { body: sitemap([G.tusc]) }, [G.florence]: { status: 404, body: 'gone' } }) });
  assert.equal(r.removed, 1);
  assert.equal(inv.getByGuid(G.florence).status, 'removed');
  assert.ok(inv.getByGuid(G.florence).slug, 'slug kept so the old URL can 301');
});

test('units are verified on the main (location-stating) site; unresolvable never-verified pages are quarantined', async () => {
  const g = 'cccccccc-1111-2222-3333-444444444444';
  const src = fakeSource({ [SM]: { body: sitemap([g]) } }); // unit page 404s
  const r = await runSync({ trigger: 'test', fetchImpl: src });
  assert.ok(src.calls.some((c) => c.startsWith(config.source.verifyBaseUrl + '/') && c.endsWith(g)), 'unit fetched from verify host');
  assert.ok(src.calls[0].startsWith(config.source.baseUrl), 'sitemap fetched from Florence host');
  assert.equal(r.quarantined, 1);
  assert.equal(inv.getByGuid(g).status, 'quarantined');
});

test('a page without the location line (as served by the Florence site) is quarantined, not assumed', () => {
  const noLoc = FLORENCE.replace(/<div class="model-location">[\s\S]*?<\/div>/, '');
  assert.equal(classifyUnit(parseUnitPage(noLoc, url(G.florence)), config.source).status, 'quarantined');
});

test('admin "hidden" override removes a unit from every public query', async () => {
  await runSync({ trigger: 'test', fetchImpl: fakeSource({ [SM]: { body: sitemap([G.florence]) }, [G.florence]: { body: FLORENCE } }) });
  assert.deepEqual(publicGuids(), [G.florence]);
  db.prepare('UPDATE overrides SET hidden=1 WHERE guid=?').run(G.florence);
  assert.deepEqual(publicGuids(), []);
  assert.equal(inv.search(inv.parseFilters({})).total, 0);
  assert.equal(inv.isPublic(inv.getByGuid(G.florence)), false);
  db.prepare('UPDATE overrides SET hidden=0 WHERE guid=?').run(G.florence);
});

test('search filters and hostile input', () => {
  assert.equal(inv.search(inv.parseFilters({ make: 'hurricane' })).total, 1);
  assert.equal(inv.search(inv.parseFilters({ make: 'Polaris' })).total, 0);
  assert.equal(inv.search(inv.parseFilters({ maxPrice: '40000' })).total, 0);
  assert.equal(inv.search(inv.parseFilters({ q: "H902' OR 1=1 --" })).total, 0);
  assert.equal(inv.search(inv.parseFilters({ q: 'h902' })).total, 1);
  assert.equal(inv.search(inv.parseFilters({ sort: 'DROP TABLE units', page: '-4', make: ['a', 'b'] })).total, 1);
});

test('lead validation, phone normalization and source attribution', () => {
  assert.equal(leads.normalizePhone('(256) 555-0142'), '+12565550142');
  assert.equal(leads.normalizePhone('1-256-555-0142'), '+12565550142');
  assert.equal(leads.normalizePhone('555-0142'), null);
  assert.equal(leads.normalizePhone('0000000000'), null);
  assert.equal(leads.validateLead({ name: 'A', phone: '1', email: 'x' }).ok, false);
  assert.equal(leads.validateLead({ name: 'Pat Rider', phone: '2565550142', consent: 'yes' }).ok, true);
  assert.equal(leads.validateLead({ name: 'Pat Rider', phone: '2565550142' }).errors.consent !== undefined, true, 'consent required');
  const s = leads.classifySource;
  assert.equal(s({ gclid: 'x' }), 'Google Ads');
  assert.equal(s({ utm_source: 'google', utm_medium: 'cpc' }), 'Google Ads');
  assert.equal(s({ utm_source: 'facebook', utm_medium: 'paid_social', fbclid: 'x' }), 'Facebook Ads');
  assert.equal(s({ utm_source: 'facebook', utm_medium: 'marketplace' }), 'Facebook Marketplace');
  assert.equal(s({ referrer: 'https://www.facebook.com/marketplace/item/1' }), 'Facebook Marketplace');
  assert.equal(s({ utm_source: 'instagram' }), 'Instagram');
  assert.equal(s({ referrer: 'https://www.google.com/' }), 'Organic Google search');
  assert.equal(s({ referrer: 'https://www.somesite.com/page' }), 'Referral');
  assert.equal(s({}), 'Direct');
});

test('lead is stored with vehicle + attribution, deduped, and shaped for Torque', () => {
  const unit = inv.getByGuid(G.florence);
  const v = leads.validateLead({ name: 'Pat Rider', phone: '256-555-0142', email: 'PAT@Example.com', consent: 'yes', intent: 'quote', message: 'Trade?' });
  const a = leads.saveLead(v.lead, { unit, attribution: JSON.stringify({ gclid: 'abc', utm_campaign: 'boats', evil: '<x>' }), pageUrl: unit.url });
  const b = leads.saveLead(v.lead, { unit, attribution: '{}' });
  assert.equal(b.duplicate, true);
  assert.equal(b.id, a.id);
  const row = db.prepare('SELECT * FROM leads WHERE id=?').get(a.id);
  assert.equal(row.stock_number, 'H902');
  assert.equal(row.source, 'Google Ads');
  assert.equal(row.crm_status, 'not_configured', 'never claims CRM delivery without a configured endpoint');
  assert.equal(JSON.parse(row.attribution).evil, undefined);
  const p = leads.torquePayload(row);
  assert.equal(p.contact.phone, '+12565550142');
  assert.equal(p.vehicle.stock_number, 'H902');
  assert.equal(p.assignment.assigned_to, 'Byron Green');
  assert.equal(p.attribution.source, 'Google Ads');
  assert.equal(p.follow_up_task.create, true);
  assert.ok(p.idempotency_key && p.contact.dedupe_key);
});

test('authorized-feed records require both location fields', () => {
  const rec = { ProductGuid: 'AAAAAAAA-1111-2222-3333-444444444444', Year: 2026, Manufacturer: 'Polaris', ModelName: 'Ranger 1000', StockNumber: 'P1', Price: '$15,999', DealershipId: config.source.florenceDealershipId.toUpperCase(), DealershipName: 'Shoals Outdoor Sports - Florence' };
  assert.equal(classifyFeedUnit(mapFeedUnit(rec)).status, 'active');
  assert.equal(mapFeedUnit(rec).price, 15999);
  assert.equal(classifyFeedUnit(mapFeedUnit({ ...rec, DealershipId: '06fcbe5c-a659-49e3-93ff-b006014cc892' })).status, 'quarantined');
  assert.equal(classifyFeedUnit(mapFeedUnit({ ...rec, DealershipName: 'Shoals Outdoor Sports - Tuscumbia', DealershipId: '06fcbe5c-a659-49e3-93ff-b006014cc892' })).status, 'other_location');
  assert.equal(classifyFeedUnit(mapFeedUnit({ ...rec, DealershipId: undefined })).status, 'quarantined');
  assert.equal(classifyFeedUnit(mapFeedUnit({ ...rec, DealershipName: undefined })).status, 'quarantined');
  assert.equal(classifyFeedUnit(mapFeedUnit({ ...rec, DateSold: '2026-11-01' })).status, 'unavailable');
});
