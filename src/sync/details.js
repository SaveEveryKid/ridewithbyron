// Model details (specifications, features, description) from the dealership's unit pages.
//
// The inventory search says what is in stock, where, and for how much — but not the specs.
// Those are on each unit's page. Specs belong to a model, not a single unit, so one page is
// read per distinct year/make/model and shared by every unit of that model. A few pages per
// scheduled run, one at a time with a pause between; a challenge from the site ends the job
// for several hours. Location and availability are never taken from these pages.
import { config } from '../config.js';
import { q, now, getSetting, setSetting, logError } from '../db.js';
import { isChallengePage } from './gate.js';

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', reg: '®', trade: '™', deg: '°', frac12: '½', frac14: '¼', frac34: '¾', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', times: '×', bull: '•' };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : ''; }
  return ENT[e.toLowerCase()] ?? m;
});
const text = (html) => decode(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const between = (html, start, ends) => {
  const i = html.indexOf(start);
  if (i < 0) return '';
  let j = html.length;
  for (const e of ends) { const k = html.indexOf(e, i + start.length); if (k > -1 && k < j) j = k; }
  return html.slice(i, j);
};

/** Unit page HTML -> { specs, features, options, headline, description, keySpecs }. Nothing is invented. */
export function parseDetails(html) {
  // --- specifications: groups of name/value rows
  const specs = [];
  const specHtml = between(html, 'id="specifications"', ['id="options"', 'id="modelphotos"', 'id="slideshow-dialog"']);
  for (const part of specHtml.split(/<h3[^>]*class="[^"]*group-title[^"]*"[^>]*>/).slice(1)) {
    const group = text(part.slice(0, part.indexOf('</h3>')));
    const rows = [];
    for (const m of part.matchAll(/<span class="spec-title">([\s\S]*?)<\/span>[\s\S]*?<span class="spec-info[^"]*">([\s\S]*?)<\/span>\s*<\/div>/g)) {
      const k = text(m[1]);
      // A value made of several paragraphs keeps them apart.
      const v = /<p[\s>]/i.test(m[2]) ? m[2].split(/<\/p>/i).map(text).filter(Boolean).join(' · ') : text(m[2]);
      if (k && v && k.length < 80) rows.push([k, v.slice(0, 600)]);
    }
    if (group && rows.length) specs.push({ group, rows });
  }
  // --- features: titled bullet lists
  const features = [];
  const featHtml = between(html, 'id="features"', ['id="specifications"', 'id="options"', 'id="modelphotos"']);
  const lis = (h) => [...h.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]).slice(0, 700)).filter(Boolean);
  const featParts = featHtml.split(/<h3[^>]*class="[^"]*feature-title[^"]*"[^>]*>/);
  for (const part of featParts.slice(1)) {
    const items = lis(part);
    if (items.length) features.push({ group: text(part.slice(0, part.indexOf('</h3>'))) || 'Features', items });
  }
  if (!features.length) { const items = lis(featHtml); if (items.length) features.push({ group: 'Features', items }); }
  // --- options / accessories
  const options = lis(between(html, 'id="options"', ['id="modelphotos"', 'id="slideshow-dialog"'])).slice(0, 60);
  // --- description
  const descBlock = between(html, 'class="model-description', ['class="details-specs', 'id="specs-container"']);
  const dm = descBlock.match(/class="description"[^>]*>([\s\S]*?)<\/div>/);
  const description = dm ? dm[1].split(/<br\s*\/?>|<\/p>|\n/i).map(text).filter(Boolean).join('\n').slice(0, 4000) || null : null;
  const hm = descBlock.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/);
  const headline = hm ? text(hm[1]).slice(0, 200) || null : null;

  const flat = specs.flatMap((g) => g.rows);
  const find = (re) => { const r = flat.find(([k]) => re.test(k)); return r ? r[1] : null; };
  const seating = find(/^(seating capacity|person capacity|passenger capacity|maximum capacity|seating)$/i) || find(/person capacity|seating capacity/i);
  const sm = seating && seating.match(/\b(\d{1,2})\b/);
  return {
    specs, features, options, headline, description,
    keySpecs: {
      engine: find(/^engine type$/i) || find(/^engine$/i), displacement: find(/displacement/i), horsepower: find(/horsepower|^hp$/i),
      seating, seats: sm ? parseInt(sm[1], 10) : null,
      groundClearance: find(/ground clearance/i), towing: find(/tow(ing)? (capacity|rating)|hitch towing/i), payload: find(/payload/i),
      bedCapacity: find(/(box|bed) capacity/i), length: find(/^length$/i), width: find(/^width$/i), height: find(/^height$/i),
      weight: find(/^weight$|dry weight/i), drive: find(/drive (system|type)|driveline/i), fuelCapacity: find(/fuel capacity/i),
    },
  };
}

/** The same model, however many units of it are in stock. Mirrors MODEL_KEY_SQL in inventory.js. */
export const modelKey = (u) => `${u.year ?? ''}|${u.make ?? ''}|${u.model ?? ''}`.toLowerCase();
export const MODEL_KEY_SQL = "lower(COALESCE(u.year,'') || '|' || COALESCE(u.make,'') || '|' || COALESCE(u.model,''))";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Read details for a few models that don't have them yet.
 * @param {{max?:number, fetchImpl?:Function, pauseMs?:number}} opts
 */
export async function runDetails(opts = {}) {
  const max = opts.max ?? 3;
  const fetchImpl = opts.fetchImpl || fetch;
  if (getSetting('sync_paused', false)) return { status: 'skipped', message: 'Synchronization is suspended' };
  const blocked = getSetting('details_blocked_until', null);
  if (blocked && new Date(blocked) > new Date()) return { status: 'skipped', message: `Paused until ${blocked}` };
  // Models with no details yet; a model that failed is tried again a day later, three times at most.
  const retryBefore = new Date(Date.now() - 24 * 3600e3).toISOString();
  const todo = await q.all(`SELECT ${MODEL_KEY_SQL} k, MIN(u.source_url) url FROM units u
    WHERE u.status='active' AND NOT EXISTS (SELECT 1 FROM model_details m WHERE m.k = ${MODEL_KEY_SQL} AND (m.ok=1 OR m.attempts>=3 OR m.fetched_at > ?))
    GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT ?`, [retryBefore, max]);
  let done = 0;
  for (const [i, t] of todo.entries()) {
    if (i) await sleep(opts.pauseMs ?? 8000);
    try {
      // Only the dealership's own sites are ever fetched.
      const host = new URL(t.url).hostname;
      if (!/(^|\.)shoalsoutdoorsports(florence)?\.com$/.test(host)) throw new Error(`Unexpected host ${host}`);
      const res = await fetchImpl(t.url, { headers: { 'User-Agent': config.source.userAgent, Accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
      const body = await res.text();
      if (/Azure WAF|JS Challenge/i.test(body.slice(0, 4000)) || ((res.status === 403 || res.status === 429) && !/specs-container/.test(body))) {
        const until = new Date(Date.now() + 6 * 3600e3).toISOString();
        await setSetting('details_blocked_until', until);
        return { status: 'blocked', message: `The dealership site asked us to stop; details paused until ${until}`, done };
      }
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const d = parseDetails(body);
      d.guid = (t.url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [''])[0].toLowerCase();
      // Pages with manufacturer feature lists carry the manufacturer's description; otherwise it is the dealer's note on that one unit.
      d.shared = d.features.length > 0;
      const found = d.specs.length || d.features.length || d.description;
      await q.run(`INSERT INTO model_details(k,ok,attempts,fetched_at,seats,source_url,data) VALUES(?,?,1,?,?,?,?)
        ON CONFLICT(k) DO UPDATE SET ok=excluded.ok, attempts=model_details.attempts+1, fetched_at=excluded.fetched_at, seats=excluded.seats, source_url=excluded.source_url, data=excluded.data`,
      [t.k, found ? 1 : 0, now(), d.keySpecs.seats, t.url, found ? JSON.stringify(d) : null]);
      if (found) done++;
    } catch (e) {
      await q.run(`INSERT INTO model_details(k,ok,attempts,fetched_at,source_url) VALUES(?,0,1,?,?)
        ON CONFLICT(k) DO UPDATE SET attempts=model_details.attempts+1, fetched_at=excluded.fetched_at`, [t.k, now(), t.url]);
      await logError('details', e, t.url);
    }
  }
  return { status: 'ok', done, tried: todo.length };
}

/** For the dashboard: how many in-stock models have their details. */
export async function detailsProgress() {
  const r = await q.get(`SELECT COUNT(*) models, SUM(CASE WHEN EXISTS (SELECT 1 FROM model_details m WHERE m.k = x.k AND m.ok=1) THEN 1 ELSE 0 END) have
    FROM (SELECT DISTINCT ${MODEL_KEY_SQL} k FROM units u WHERE u.status='active') x`);
  return { models: r ? r.models : 0, have: r && r.have ? r.have : 0, blockedUntil: getSetting('details_blocked_until', null) };
}
