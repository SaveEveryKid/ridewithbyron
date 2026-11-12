// Dealer-site search source — the same mechanism Torque CRM's Inventory screen uses.
//
// The dealership's inventory pages carry a search-only key for the site's own inventory index
// (the key every visitor's browser receives; scoped to this dealer's unsold units; renewed hourly).
// One page read + a few search requests return the entire inventory, each record stating its
// dealership by name. That is ~5 requests per sync instead of hundreds of page loads.
//
// Every record still passes the Florence gate (classifyUnit): DealershipName must equal the
// Florence name AND any dealership id embedded in its photo paths must be the Florence id.
import { config } from '../config.js';
import { classifyUnit, isChallengePage } from './gate.js';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v) => (typeof v === 'string' ? v.trim() || null : typeof v === 'number' ? String(v) : null);
const num = (v) => { const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[^0-9.]/g, '')) : NaN; return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };

class SourceChallenge extends Error {}
const FIELDS = ['objectID', 'Year', 'Manufacturer', 'ProductName', 'ProductType', 'ProductCategory', 'Condition', 'IsUsed', 'Price', 'SalePrice', 'Msrp', 'StockNumber', 'Vin', 'PhotoUrl', 'PhotoLists', 'ShowroomUrl', 'Color', 'DealershipName', 'Odometer', 'HasOdometer', 'OdometerUomCode', 'Specs', 'Description', 'Comments'];

/** Pull the search setup out of a dealer inventory page. */
function parseSearchConfig(html) {
  const m = html.match(/<script[^>]*class="showroom-search--config"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("Search configuration not found on the dealer page (the site may have changed)");
  const c = JSON.parse(m[1]);
  if (!c.appId || !c.apiKey || !/^[A-Za-z0-9]+$/.test(c.appId)) throw new Error('Dealer page has no usable search key');
  return { appId: c.appId, apiKey: c.apiKey, index: c.defaultIndexName || 'prod_WebSellable', pageDealershipId: String(c.dealershipId || '').toLowerCase() };
}

function specGroups(raw) {
  // Specs arrive in a few shapes depending on the unit; keep only clean name/value pairs.
  const rows = [];
  const add = (k, v) => { k = str(k); v = str(v); if (k && v && k.length < 80 && v.length < 600) rows.push([k, v]); };
  if (Array.isArray(raw)) for (const s of raw) { if (s && typeof s === 'object') add(s.Name || s.name || s.Title || s.Key, s.Value || s.value || s.Description); }
  else if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) add(k, v);
  return rows.length ? [{ group: 'Specifications', rows }] : [];
}

/** One search hit -> the same normalized record the page parser produces. */
function mapHit(h) {
  const guid = GUID.test(h.objectID || '') ? h.objectID.toLowerCase() : null;
  const year = parseInt(h.Year, 10) || null;
  const make = str(h.Manufacturer);
  const model = str(h.ProductName);
  const gallery = (Array.isArray(h.PhotoLists) ? h.PhotoLists : []).filter((p) => p && typeof p.Url === 'string' && p.Url)
    .sort((a, b) => (a.Seq || 0) - (b.Seq || 0)).map((p) => p.Url);
  const images = [...new Set([str(h.PhotoUrl), ...gallery].filter((u) => u && /^https:\/\/cdpcdn\.dx1app\.com\/products/.test(u)))];
  const ids = [...new Set(images.map((u) => (u.match(/products-private\/prod\/[0-9a-f-]{36}\/([0-9a-f-]{36})\//i) || [])[1]).filter(Boolean).map((x) => x.toLowerCase()))];
  // Advertised price: sale price when one is set, otherwise the listed price. MSRP only as a "was" figure.
  const listed = num(h.Price);
  const sale = num(h.SalePrice);
  const price = sale && (!listed || sale < listed) ? sale : listed;
  const msrpRaw = num(h.Msrp);
  const was = sale && listed && sale < listed ? listed : msrpRaw;
  const specs = specGroups(h.Specs);
  const flat = specs.flatMap((g) => g.rows);
  const find = (re) => { const r = flat.find(([k]) => re.test(k)); return r ? r[1] : null; };
  const seating = find(/person capacity|seating capacity|^seating$/i);
  return {
    guid, sourceUrl: str(h.ShowroomUrl) || `${'https://www.shoalsoutdoorsports.com'}/dx1inventory/${guid}`,
    title: [year, make, model].filter(Boolean).join(' ') || null, year, make, model,
    condition: h.IsUsed === true || /used/i.test(String(h.Condition || '')) ? 'Used' : 'New',
    stockNumber: str(h.StockNumber), vin: str(h.Vin), vinLabel: str(h.Vin) ? (/boat|watercraft|pontoon/i.test(String(h.ProductType || '')) ? 'HIN' : 'VIN') : null,
    // Live data: ProductCategory is the broad group ("Utility Vehicles"), ProductType the subtype ("Crew Cab").
    category: str(h.ProductCategory), modelType: str(h.ProductType), modelCode: null, color: str(h.Color),
    price: price || null, msrp: was && price && was > price ? was : (price ? null : msrpRaw), onSale: !!(sale && listed && sale < listed),
    priceLabel: null, priceNote: null, promoBanner: null, payment: null,
    headline: null, description: str(h.Description) || str(h.Comments) || null,
    specs, features: [], options: [], images,
    keySpecs: {
      seating, seats: seating && /\b(\d{1,2})\b/.test(seating) ? parseInt(seating.match(/\b(\d{1,2})\b/)[1], 10) : null,
      engine: find(/^engine type$|^engine$/i), displacement: find(/displacement/i), horsepower: find(/horsepower/i),
      groundClearance: find(/ground clearance/i), towing: find(/tow(ing)? (capacity|rating)|hitch towing/i), payload: find(/payload/i),
      bedCapacity: find(/(box|bed) capacity/i), usage: h.HasOdometer && num(h.Odometer) ? `${num(h.Odometer).toLocaleString('en-US')} ${/hour/i.test(String(h.OdometerUomCode)) ? 'hrs' : 'mi'}` : null,
    },
    evidence: {
      locationName: str(h.DealershipName),
      imageDealershipIds: ids,
      // The index holds only unsold, web-sellable units (enforced by the key itself).
      availabilityText: 'In Stock',
      source: 'search',
    },
  };
}

const classifySearchUnit = (u) => classifyUnit(u, config.source);

async function fetchAll(fetchImpl = fetch) {
  const headers = { 'User-Agent': config.source.userAgent, Accept: 'text/html' };
  const pageUrl = config.source.baseUrl + config.source.searchConfigPath;
  const getPage = async () => {
    const r = await fetchImpl(pageUrl, { headers, signal: AbortSignal.timeout(30000) });
    const body = await r.text();
    if (isChallengePage(r.status, body)) throw new SourceChallenge(`Anti-bot challenge at ${config.source.searchConfigPath} (HTTP ${r.status})`);
    if (r.status !== 200) throw new Error(`Dealer page returned HTTP ${r.status}`);
    return parseSearchConfig(body);
  };
  let cfg;
  try { cfg = await getPage(); } catch (e) {
    if (!(e instanceof SourceChallenge)) throw e;
    await new Promise((r) => setTimeout(r, config.source.challengeBackoffMs)); // one polite retry, never a workaround
    cfg = await getPage();
  }
  const hits = [];
  let total = 0;
  for (let page = 0; page < 15; page++) {
    const params = new URLSearchParams({ query: '', page: String(page), hitsPerPage: '200', attributesToRetrieve: JSON.stringify(FIELDS), attributesToHighlight: '[]' });
    const r = await fetchImpl(`https://${cfg.appId.toLowerCase()}-dsn.algolia.net/1/indexes/${encodeURIComponent(cfg.index)}/query`, {
      method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { 'X-Algolia-Application-Id': cfg.appId, 'X-Algolia-API-Key': cfg.apiKey, 'Content-Type': 'application/json', 'User-Agent': config.source.userAgent },
      body: JSON.stringify({ params: params.toString() }),
    });
    if (!r.ok) throw new Error(`Inventory search returned HTTP ${r.status}`);
    const body = await r.json();
    hits.push(...(body.hits || []));
    total = body.nbHits || hits.length;
    if (page + 1 >= (body.nbPages || 1)) break;
  }
  // An incomplete read must never be mistaken for "the rest sold".
  if (hits.length < total) throw new Error(`Search returned ${hits.length} of ${total} units — incomplete read, not applied`);
  return hits.map(mapHit);
}

export { parseSearchConfig, mapHit, classifySearchUnit, fetchAll, SourceChallenge };
