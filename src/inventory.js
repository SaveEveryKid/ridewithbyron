// Read-side of the catalog. The single definition of "publicly visible" lives here.
import { config } from './config.js';
import { q } from './db.js';
import { slugify } from './sync/taxonomy.js';
import { MODEL_KEY_SQL } from './sync/details.js';

// Public = verified Florence + in stock on last check + verified recently + not hidden by admin.
const PUBLIC_WHERE = `u.status='active' AND u.last_verified >= @hideCutoff AND COALESCE(o.hidden,0)=0`;
const base = () => ({ hideCutoff: new Date(Date.now() - config.source.hideAfterHours * 3600e3).toISOString() });
// Model details (specs, features) are joined in by year|make|model; see sync/details.js.
const JOINS = `FROM units u LEFT JOIN overrides o ON o.guid=u.guid LEFT JOIN model_details m ON m.k = ${MODEL_KEY_SQL} AND m.ok=1`;
const SEATS = 'COALESCE(u.seats, m.seats)';
const SELECT = `SELECT u.*, COALESCE(o.featured,0) featured, o.badge, o.note, m.data mdata, m.seats mseats ${JOINS}`;

function hydrate(row) {
  if (!row) return null;
  let data = {};
  try { data = row.data ? JSON.parse(row.data) : {}; } catch { data = {}; }
  // Fill in what the inventory search doesn't carry, from the model's details page.
  if (row.mdata) {
    try {
      const m = JSON.parse(row.mdata);
      if (!(data.specs || []).length) data.specs = m.specs || [];
      if (!(data.features || []).length) data.features = m.features || [];
      if (!(data.options || []).length) data.options = m.options || [];
      const k = data.keySpecs || {};
      data.keySpecs = { ...m.keySpecs, ...Object.fromEntries(Object.entries(k).filter(([, v]) => v != null)) };
      // A manufacturer's description applies to every unit of the model; a dealer's note about one unit only to that unit.
      if (!data.description && m.description && (m.shared || m.guid === row.guid)) data.description = m.description;
    } catch { /* ignore a damaged details row */ }
  }
  row = { ...row, seats: row.seats ?? row.mseats ?? null, mdata: undefined };
  const staleCutoff = Date.now() - config.source.staleAfterMinutes * 60000;
  const images = data.images || [];
  return {
    ...row, data,
    images,
    thumb: images[0] ? images[0].replace(/(\.\w+)$/, '_480px$1') : null,
    stale: !row.last_verified || new Date(row.last_verified).getTime() < staleCutoff,
    url: `/inventory/${row.slug}`,
    isNewArrival: row.first_active && Date.now() - new Date(row.first_active).getTime() < 14 * 86400e3,
  };
}

const SORTS = {
  featured: 'featured DESC, u.first_active DESC, u.year DESC',
  newest: 'u.first_active DESC, u.year DESC',
  'price-asc': 'CASE WHEN u.price IS NULL THEN 1 ELSE 0 END, u.price ASC',
  'price-desc': 'CASE WHEN u.price IS NULL THEN 1 ELSE 0 END, u.price DESC',
  'year-desc': 'u.year DESC, u.title ASC',
  'year-asc': 'u.year ASC, u.title ASC',
};

/** Normalize untrusted query-string filters. */
function parseFilters(q = {}) {
  const str = (v, max = 60) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const int = (v) => { const n = parseInt(str(v, 9).replace(/[^\d]/g, ''), 10); return Number.isFinite(n) ? n : null; };
  return {
    q: str(q.q, 80), make: str(q.make), family: str(q.family), model: str(q.model, 80), type: str(q.type),
    condition: ['New', 'Used'].includes(str(q.condition)) ? str(q.condition) : '',
    year: int(q.year), minPrice: int(q.minPrice), maxPrice: int(q.maxPrice), seats: int(q.seats),
    feature: str(q.feature), sale: q.sale === '1',
    sort: SORTS[str(q.sort)] ? str(q.sort) : 'featured',
    page: Math.max(1, int(q.page) || 1),
  };
}

// "Available features" are detected from text the source itself publishes for the unit.
const FEATURES = {
  'Power Steering': /\b(eps|power steering)\b/i,
  'Enclosed Cab': /\b(northstar|enclosed cab|full cab|cab system)\b/i,
  'Heat & A/C': /\b(heat(ing)? (and|&) (air|a\/c)|hvac|air conditioning)\b/i,
  'Winch': /\bwinch\b/i,
  'Ride Command': /ride command/i,
  'Roof': /\broof\b/i,
  'Crew / 4+ Seats': /\bcrew\b/i,
  'Trailer Included': /trailer/i,
};
const featureText = (u) => [u.title, u.model_type, (u.data && u.data.description) || '', ...(((u.data && u.data.features) || []).flatMap((g) => g.items))].join(' \n ');
const unitFeatures = (u) => Object.keys(FEATURES).filter((k) => FEATURES[k].test(featureText(u)));

async function search(filters, { pageSize = 24 } = {}) {
  const f = filters;
  const where = [PUBLIC_WHERE];
  const p = base();
  const eq = (col, key, val) => { if (val) { where.push(`lower(${col}) = lower(@${key})`); p[key] = val; } };
  eq('u.make', 'make', f.make); eq('u.family', 'family', f.family); eq('u.vtype', 'type', f.type);
  eq('u.condition', 'condition', f.condition); eq('u.model', 'model', f.model);
  if (f.year) { where.push('u.year=@year'); p.year = f.year; }
  if (f.minPrice != null) { where.push('u.price >= @minPrice'); p.minPrice = f.minPrice; }
  if (f.maxPrice != null) { where.push('u.price <= @maxPrice'); p.maxPrice = f.maxPrice; }
  if (f.seats) { where.push(f.seats >= 6 ? `${SEATS} >= 6` : `${SEATS} = @seats`); if (f.seats < 6) p.seats = f.seats; }
  if (f.sale) where.push('u.on_sale=1');
  if (f.q) {
    f.q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6).forEach((tok, i) => {
      where.push(`lower(u.title || ' ' || COALESCE(u.stock_number,'') || ' ' || COALESCE(u.color,'') || ' ' || COALESCE(u.vtype,'') || ' ' || COALESCE(u.category,'')) LIKE @q${i} ESCAPE '\\'`);
      p[`q${i}`] = `%${tok.replace(/[\\%_]/g, '\\$&')}%`;
    });
  }
  let rows = (await q.all(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY ${SORTS[f.sort]}`, p)).map(hydrate);
  if (f.feature && FEATURES[f.feature]) rows = rows.filter((u) => FEATURES[f.feature].test(featureText(u)));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(f.page, pages);
  return { units: rows.slice((page - 1) * pageSize, page * pageSize), total, page, pages };
}

/** Facet values + counts from what is actually in stock at Florence right now. */
async function facets() {
  const rows = await q.all(`SELECT u.make,u.family,u.vtype,u.condition,u.year,${SEATS} seats,u.price,u.model ${JOINS} WHERE ${PUBLIC_WHERE}`, base());
  const count = (key) => {
    const m = new Map();
    for (const r of rows) if (r[key] != null && r[key] !== '') m.set(r[key], (m.get(r[key]) || 0) + 1);
    return [...m.entries()].map(([value, n]) => ({ value, n }));
  };
  const by = (a, b) => b.n - a.n || String(a.value).localeCompare(String(b.value));
  const prices = rows.map((r) => r.price).filter((x) => x != null);
  return {
    total: rows.length,
    makes: count('make').sort(by), families: count('family').sort(by), types: count('vtype').sort(by),
    conditions: count('condition').sort(by), years: count('year').sort((a, b) => b.value - a.value),
    seats: count('seats').sort((a, b) => a.value - b.value),
    features: Object.keys(FEATURES),
    priceMin: prices.length ? Math.min(...prices) : null, priceMax: prices.length ? Math.max(...prices) : null,
    polarisFamilies: (() => {
      const m = new Map();
      for (const r of rows) if (/polaris/i.test(r.make || '') && r.family) m.set(r.family, (m.get(r.family) || 0) + 1);
      return [...m.entries()].map(([value, n]) => ({ value, n })).sort(by);
    })(),
  };
}

const getBySlug = async (slug) => hydrate(await q.get(`${SELECT} WHERE u.slug=?`, [slug]));
const getByGuid = async (guid) => hydrate(await q.get(`${SELECT} WHERE u.guid=?`, [guid]));
const isPublic = async (u) => !!u && u.status === 'active' && !u.hidden &&
  (await q.get(`SELECT 1 ok FROM units u LEFT JOIN overrides o ON o.guid=u.guid WHERE u.guid=@g AND ${PUBLIC_WHERE}`, { g: u.guid, ...base() })) !== undefined;

const list = async (whereExtra, order, limit, params = {}) =>
  (await q.all(`${SELECT} WHERE ${PUBLIC_WHERE} ${whereExtra ? 'AND ' + whereExtra : ''} ORDER BY ${order} LIMIT ${Number(limit)}`, { ...base(), ...params })).map(hydrate);

const featured = async (n = 8) => {
  const picked = await list('o.featured=1', 'o.updated_at DESC', n);
  if (picked.length >= 4) return picked;
  // No manual picks yet: lead with units that have real photos and a published price.
  const fill = await list("u.price IS NOT NULL AND u.data LIKE '%products-private%'", 'u.on_sale DESC, u.first_active DESC', n);
  const seen = new Set(picked.map((u) => u.guid));
  return [...picked, ...fill.filter((u) => !seen.has(u.guid))].slice(0, n);
};
const latest = (n = 8) => list('', 'u.first_active DESC, u.year DESC', n);
const related = (u, n = 4) => list('u.guid != @g AND (u.family = @fam OR (u.make = @make AND u.vtype = @vt) OR u.vtype = @vt2)',
  'CASE WHEN u.family=@fam2 THEN 0 WHEN u.make=@make2 THEN 1 ELSE 2 END, ABS(COALESCE(u.price,0)-@price)', n,
  { g: u.guid, fam: u.family || '', make: u.make || '', vt: u.vtype || '', vt2: u.vtype || '', fam2: u.family || '', make2: u.make || '', price: u.price || 0 });
/** Lightweight list for the sitemap (no JSON payloads). */
const publicUrls = async () => q.all(`SELECT u.slug, u.last_changed, u.last_verified FROM units u LEFT JOIN overrides o ON o.guid=u.guid WHERE ${PUBLIC_WHERE} ORDER BY u.first_active DESC LIMIT 5000`, base());
const allPublic = () => list('', 'u.first_active DESC', 5000);

export { search, facets, parseFilters, getBySlug, getByGuid, isPublic, featured, latest, related, allPublic, publicUrls, unitFeatures, slugify, SORTS };
