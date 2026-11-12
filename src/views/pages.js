import { config } from '../config.js';
import * as inv from '../inventory.js';
import { syncHealth } from '../sync/engine.js';
import { LANDING } from '../seo.js';
import { INTENTS } from '../leads.js';
import * as ui from './ui.js';

const { esc, money, jsonLd, layout, card, leadForm, leadBtn, callBtn, textBtn, ago, content } = ui;

const D = new Proxy({}, { get: (_, k) => config.dealership[k] });
const qs = (obj) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(obj)) if (v !== '' && v != null && v !== false && !(k === 'page' && v === 1) && !(k === 'sort' && v === 'featured')) p.set(k, v === true ? '1' : v); const s = p.toString(); return s ? '?' + s : ''; };

function syncBanner() {
  const h = syncHealth();
  if (!h.lastSuccess) return `<div class="notice">Florence inventory is being loaded from the dealership for the first time. Please <a href="/contact">contact Byron</a> for what’s available right now.</div>`;
  if (h.stale) return `<div class="notice">Heads up: the dealership feed hasn’t been confirmed since ${esc(new Date(h.lastSuccess).toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' }))} CT. Listings may be out of date — please confirm availability with Byron.</div>`;
  return '';
}
function freshness() {
  const h = syncHealth();
  if (!h.lastSuccess) return '<span><span class="dot warn"></span>Inventory sync starting</span>';
  return h.stale ? `<span><span class="dot warn"></span>Last confirmed ${ago(h.lastSuccess)}</span>` : `<span><span class="dot"></span>Florence inventory checked <b>${ago(h.lastSuccess)}</b></span>`;
}

const dealerLd = () => ({
  '@context': 'https://schema.org', '@type': 'AutomotiveBusiness', name: 'Shoals Outdoor Sports - Florence',
  address: { '@type': 'PostalAddress', streetAddress: D.street, addressLocality: D.city, addressRegion: D.region, postalCode: D.zip, addressCountry: 'US' },
});
const personLd = () => ({
  '@context': 'https://schema.org', '@type': 'Person', name: 'Byron Green', jobTitle: 'Sales Representative', url: config.siteUrl + '/about',
  worksFor: { '@type': 'AutomotiveBusiness', name: 'Shoals Outdoor Sports - Florence', address: dealerLd().address },
});

const heroArt = `<svg class="hero-art" viewBox="0 0 1440 620" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
<defs><linearGradient id="hg1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1c4f8f"/><stop offset="1" stop-color="#0b1626"/></linearGradient><linearGradient id="hg2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#12335e"/><stop offset="1" stop-color="#07080a"/></linearGradient>
<linearGradient id="hg3" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#1488ff" stop-opacity="0"/><stop offset=".5" stop-color="#52adff"/><stop offset="1" stop-color="#1488ff" stop-opacity="0"/></linearGradient></defs>
<g opacity=".5" fill="none" stroke="#2a6bc0" stroke-width="1"><path d="M700 80c120-40 300-30 420 30s250 40 340 0"/><path d="M660 130c140-50 320-30 450 30s240 50 350 10" opacity=".7"/><path d="M640 185c150-50 330-30 460 30s240 50 360 10" opacity=".45"/></g>
<path d="M620 470 860 250l70 60 130-170 150 150 80-50 190 230z" fill="url(#hg1)" opacity=".75"/>
<path d="M1060 140l-46 98 46-26 30 46 22-54 52 22z" fill="#dbe7f5" opacity=".85"/>
<path d="M480 560 760 360l90 70 170-140 160 130 110-60 220 200z" fill="url(#hg2)"/>
<path d="M0 520c300-70 620-40 900 10s420 20 540-10" fill="none" stroke="url(#hg3)" stroke-width="3"/>
<g fill="#1488ff" opacity=".5"><path d="M980 560l26-16 10 14-26 16zM1030 548l26-16 10 14-26 16zM1080 536l26-16 10 14-26 16zM1130 524l26-16 10 14-26 16zM1180 512l26-16 10 14-26 16zM1230 500l26-16 10 14-26 16zM1280 488l26-16 10 14-26 16zM1330 476l26-16 10 14-26 16z"/></g></svg>`;

async function home() {
  const c = content();
  const f = await inv.facets();
  const featured = await inv.featured(8);
  const latest = await inv.latest(8);
  const catTiles = [];
  for (const fam of f.polarisFamilies) catTiles.push({ href: `/inventory${qs({ make: 'Polaris', family: fam.value })}`, kicker: 'Polaris', name: fam.value === 'Youth' ? 'Youth' : fam.value, n: fam.n });
  for (const t of f.types) catTiles.push({ href: `/inventory${qs({ type: t.value })}`, kicker: 'Shop', name: t.value, n: t.n });
  const tiles = catTiles.slice(0, 12);
  const body = `
<section class="hero">${c.heroImage ? `<img class="hero-photo" src="${esc(c.heroImage)}" alt="" fetchpriority="high">` : heroArt}
<div class="wrap">
<span class="eyebrow">Byron Green · Shoals Outdoor Sports · Florence, AL</span>
<h1>Your next <em>adventure</em> starts here.</h1>
<p>Find your next Ranger, RZR, ATV, side-by-side or boat with Byron Green at Shoals Outdoor Sports in Florence, Alabama.</p>
<div class="hero-btns"><a class="btn btn-primary" href="/inventory">Shop Inventory</a>${textBtn('btn btn-white', 'Text Byron')}</div>
<div class="hero-meta">${freshness()}${f.total ? `<span><b>${f.total}</b> units within reach</span>` : ''}${c.showNoFees ? '<span>Upfront pricing · <b>no dealer fees</b></span>' : ''}</div>
</div></section>

<div class="wrap">
<form class="finder" action="/inventory" method="get" role="search" aria-label="Search Florence inventory">
<label class="f">Search Florence inventory<input name="q" type="search" placeholder="Ranger Crew, RZR, pontoon, stock #…" enterkeyhint="search"></label>
<label class="f">Type<select name="type"><option value="">All types</option>${f.types.map((t) => `<option value="${esc(t.value)}">${esc(t.value)} (${t.n})</option>`).join('')}</select></label>
<label class="f">Make<select name="make"><option value="">All makes</option>${f.makes.map((t) => `<option value="${esc(t.value)}">${esc(t.value)} (${t.n})</option>`).join('')}</select></label>
<label class="f">Condition<select name="condition"><option value="">New &amp; used</option>${f.conditions.map((t) => `<option value="${esc(t.value)}">${t.value === 'Used' ? 'Pre-owned' : 'New'} (${t.n})</option>`).join('')}</select></label>
<button class="btn btn-primary" type="submit">Search</button>
</form>
${syncBanner()}
</div>

${tiles.length ? `<section class="sec"><div class="wrap"><div class="sec-head"><div><span class="eyebrow">Within reach</span><h2>Shop by <span>category</span></h2><div class="slash"></div></div><a href="/inventory">View all ${f.total} →</a></div>
<div class="cats">${tiles.map((t) => `<a class="cat" href="${esc(t.href)}"><i>${esc(t.kicker)}</i><b>${esc(t.name)}</b><span>${t.n} in stock</span></a>`).join('')}</div></div></section>` : ''}

${featured.length ? `<section class="sec sec-alt"><div class="wrap"><div class="sec-head"><div><span class="eyebrow">Byron’s picks</span><h2>Featured <span>Florence</span> inventory</h2><div class="slash"></div></div><a href="/inventory">Shop all inventory →</a></div>
<div class="grid four">${featured.map((u, i) => card(u, { eager: i < 2 })).join('')}</div></div></section>` : ''}

<section class="sec"><div class="wrap"><div class="sec-head"><div><span class="eyebrow">One person. Straight answers.</span><h2>Why buy with <span>Byron?</span></h2><div class="slash"></div></div></div>
<div class="why">
<div><h3>You deal with one person</h3><p>Your call, text or form goes to Byron — not a call center or a shared inbox. Same person from first question to delivery day.</p></div>
<div><h3>Straightforward buying</h3><p>${c.showNoFees ? 'Shoals Outdoor Sports gives its best price up front, with no dealer fees. Byron walks you through the numbers line by line.' : 'Clear numbers explained line by line, so you know exactly what you’re paying for before you sign anything.'}</p></div>
<div><h3>Real product knowledge</h3><p>More than a decade selling vehicles. Byron will help you match the machine to how you’ll actually use it — work, trail, hunting or the lake.</p></div>
<div><h3>No pressure</h3><p>Ask as many questions as you want. If it’s not the right fit or the right time, that’s fine.</p></div>
<div><h3>Inventory within reach</h3><p>Every unit you see here is one Byron can get to easily, re-checked against the dealership’s listings throughout the day.</p></div>
<div><h3>Backed by the dealership</h3><p>Every purchase is completed through Shoals Outdoor Sports, with its sales, finance, parts and service departments behind you.</p></div>
</div></div></section>

${latest.length ? `<section class="sec sec-alt"><div class="wrap"><div class="sec-head"><div><span class="eyebrow">Just listed</span><h2>Latest <span>Florence</span> arrivals</h2><div class="slash"></div></div><a href="/inventory?sort=newest">See newest first →</a></div>
<div class="grid four">${latest.map((u) => card(u)).join('')}</div></div></section>` : ''}

${c.testimonials && c.testimonials.length ? `<section class="sec"><div class="wrap"><div class="sec-head"><div><span class="eyebrow">From customers</span><h2>What riders <span>say</span></h2><div class="slash"></div></div></div>
<div class="grid">${c.testimonials.map((t) => `<blockquote class="quote"><p>“${esc(t.quote)}”</p><footer>— ${esc(t.name)}${t.detail ? ', ' + esc(t.detail) : ''}</footer></blockquote>`).join('')}</div></div></section>` : ''}

<section class="sec" id="contact"><div class="wrap split">
<div class="contact-card"><span class="eyebrow">Direct contact</span><h2>Talk to Byron</h2><p class="lede" style="margin-top:10px">Questions about a unit, a trade, or what fits your budget? Reach Byron directly — he’ll get back to you personally.</p>
<div class="btns">${textBtn('btn btn-primary', 'Text Byron')}${callBtn('btn btn-ghost', 'Call Byron')}${leadBtn('quote', 'Get My Best Quote', 'btn btn-ghost')}${leadBtn('availability', 'Check Availability', 'btn btn-ghost')}${leadBtn('visit', 'Schedule a Visit', 'btn btn-ghost')}${leadBtn('financing', 'Ask About Financing', 'btn btn-ghost')}</div></div>
<div class="map-card"><span class="eyebrow">Dealership location</span><h2>Visit the Florence store</h2>
<p style="margin-top:12px"><b>${esc(D.locationName)}</b><br>${esc(D.street)}<br>${esc(D.city)}, ${D.region} ${D.zip}</p>
<table class="hours"><tbody>${c.hours.map(([d, h]) => `<tr><td>${esc(d)}</td><td>${esc(h)}</td></tr>`).join('')}</tbody></table>
<p class="muted small" style="margin-top:8px">Dealership hours as published by Shoals Outdoor Sports. Ask for Byron when you arrive — or schedule ahead so he’s ready for you.</p>
<div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn btn-primary" href="${D.mapsUrl}" target="_blank" rel="noopener">${ui.ICON.pin}<span>Get Directions</span></a>${leadBtn('visit', 'Schedule a Visit', 'btn btn-ghost')}</div></div>
</div></section>`;
  return layout({
    path: '/', canonical: '/', body,
    title: 'Ride With Byron | Polaris, Side-by-Sides, ATVs & Boats in Florence, AL',
    description: 'Shop live Florence, AL inventory from Shoals Outdoor Sports — Polaris Ranger, RZR, ATVs, side-by-sides and boats — and deal directly with sales rep Byron Green. Find Your Ride. Fuel Your Adventure.',
    head: jsonLd(personLd()) + jsonLd({ '@context': 'https://schema.org', '@type': 'WebSite', name: 'RideWithByron.com', url: config.siteUrl, potentialAction: { '@type': 'SearchAction', target: config.siteUrl + '/inventory?q={search_term_string}', 'query-input': 'required name=search_term_string' } }),
  });
}

function filterForm(f, fac, action = '/inventory') {
  const sel = (name, label, opts, cur, all) => `<label class="f">${label}<select name="${name}"><option value="">${all}</option>${opts.map((o) => `<option value="${esc(o.value)}"${String(cur).toLowerCase() === String(o.value).toLowerCase() ? ' selected' : ''}>${esc(o.label || o.value)}${o.n != null ? ` (${o.n})` : ''}</option>`).join('')}</select></label>`;
  return `<aside class="filters"><details class="fwrap" data-filters open><summary>Filter inventory <span class="chev">▾</span></summary>
<form action="${action}" method="get">
<label class="f">Keyword<input type="search" name="q" value="${esc(f.q)}" placeholder="Model, color, stock #"></label>
${sel('type', 'Vehicle type', fac.types, f.type, 'All types')}
${sel('make', 'Manufacturer', fac.makes, f.make, 'All makes')}
${fac.families.length ? sel('family', 'Model line', fac.families, f.family, 'All model lines') : ''}
${sel('condition', 'New or used', fac.conditions.map((c) => ({ ...c, label: c.value === 'Used' ? 'Pre-owned' : 'New' })), f.condition, 'New & pre-owned')}
${sel('year', 'Year', fac.years, f.year || '', 'Any year')}
<div class="two"><label class="f">Min price<input name="minPrice" inputmode="numeric" placeholder="$" value="${f.minPrice ?? ''}"></label><label class="f">Max price<input name="maxPrice" inputmode="numeric" placeholder="$" value="${f.maxPrice ?? ''}"></label></div>
${fac.seats.length ? sel('seats', 'Seating', fac.seats.map((s) => ({ value: s.value, label: `${s.value} seat${s.value === 1 ? '' : 's'}`, n: s.n })), f.seats || '', 'Any seating') : ''}
${sel('feature', 'Features', fac.features.map((x) => ({ value: x })), f.feature, 'Any features')}
<label class="check" style="font-size:.9rem;color:var(--text);align-items:center"><input type="checkbox" name="sale" value="1"${f.sale ? ' checked' : ''}><span>On sale only</span></label>
<input type="hidden" name="sort" value="${esc(f.sort)}">
<button class="btn btn-primary btn-block" type="submit">Apply filters</button>
<a class="btn btn-ghost btn-block btn-sm" href="${action}">Clear all</a>
</form></details></aside>`;
}

function resultsBlock(f, res, action) {
  const sortOpts = [['featured', 'Featured'], ['newest', 'Newest arrivals'], ['price-asc', 'Price: low to high'], ['price-desc', 'Price: high to low'], ['year-desc', 'Model year: newest'], ['year-asc', 'Model year: oldest']];
  const { page: _p, ...rest } = f;
  const link = (p) => action + qs({ ...rest, page: p });
  const pager = res.pages > 1 ? `<nav class="pager" aria-label="Pages">${res.page > 1 ? `<a href="${esc(link(res.page - 1))}" rel="prev">‹ Prev</a>` : ''}${Array.from({ length: res.pages }, (_, i) => i + 1).filter((p) => Math.abs(p - res.page) < 3 || p === 1 || p === res.pages).map((p) => (p === res.page ? `<span aria-current="page">${p}</span>` : `<a href="${esc(link(p))}">${p}</a>`)).join('')}${res.page < res.pages ? `<a href="${esc(link(res.page + 1))}" rel="next">Next ›</a>` : ''}</nav>` : '';
  return `<div><div class="inv-bar"><div><b>${res.total}</b> <span class="muted">${res.total === 1 ? 'unit' : 'units'} in stock</span></div>
<form method="get" action="${action}" data-autosubmit>${Object.entries(rest).filter(([k, v]) => k !== 'sort' && v !== '' && v != null && v !== false).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v === true ? '1' : v)}">`).join('')}<label class="sr" for="sort">Sort by</label><select id="sort" name="sort">${sortOpts.map(([v, l]) => `<option value="${v}"${f.sort === v ? ' selected' : ''}>${l}</option>`).join('')}</select><noscript><button class="btn btn-ghost btn-sm">Sort</button></noscript></form></div>
${res.units.length ? `<div class="grid">${res.units.map((u, i) => card(u, { eager: i < 3 })).join('')}</div>${pager}` : `<div class="empty"><h3 style="margin-bottom:8px">Nothing within reach matches that right now</h3><p>Inventory changes daily, and Byron often knows what’s inbound before it’s listed.</p><div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">${leadBtn('availability', 'Ask Byron to find one', 'btn btn-primary')}<a class="btn btn-ghost" href="/inventory">See all inventory</a></div></div>`}</div>`;
}

async function inventory(query) {
  const f = inv.parseFilters(query);
  const fac = await inv.facets();
  const res = await inv.search(f);
  const filtered = Object.entries(f).some(([k, v]) => !['sort', 'page'].includes(k) && v !== '' && v != null && v !== false);
  const bits = [f.condition === 'Used' ? 'Pre-Owned' : f.condition, f.year, f.make, f.family, f.type && !f.family ? f.type : ''].filter(Boolean).join(' ');
  const h1 = bits ? `${bits} in Florence, AL` : 'Florence Inventory';
  return layout({
    path: '/inventory', canonical: '/inventory',
    // Filtered/sorted/paged views are not indexed; the clean landing pages and unit pages are.
    noindex: filtered || f.page > 1 || f.sort !== 'featured',
    title: `${bits ? bits + ' for Sale' : 'Powersports Inventory'} in Florence, AL | Ride With Byron`,
    description: `Browse ${res.total} powersports units available through Byron Green at Shoals Outdoor Sports in Florence, Alabama. Filter by make, model, price and features, then contact Byron directly.`,
    body: `<div class="page-head"><div class="wrap"><div class="crumbs"><a href="/">Home</a> / Inventory</div><h1>${esc(h1)}</h1><p class="lede">Every unit here is within reach — Byron can get to it easily. ${freshness()}</p></div></div>
<div class="wrap">${syncBanner()}<div class="inv">${filterForm(f, fac)}${resultsBlock(f, res, '/inventory')}</div></div>`,
  });
}

async function landing(l, query) {
  const f = { ...inv.parseFilters(query), ...l.filter };
  const res = await inv.search(f, { pageSize: 24 });
  const others = LANDING.filter((x) => x.slug !== l.slug).slice(0, 7);
  return layout({
    path: '/' + l.slug, canonical: '/' + l.slug, title: l.title, description: l.desc, noindex: f.page > 1,
    head: jsonLd({ '@context': 'https://schema.org', '@type': 'ItemList', name: l.h1, numberOfItems: res.total, itemListElement: res.units.slice(0, 24).map((u, i) => ({ '@type': 'ListItem', position: i + 1, url: config.siteUrl + u.url, name: u.title })) }),
    body: `<div class="page-head"><div class="wrap"><div class="crumbs"><a href="/">Home</a> / <a href="/inventory">Inventory</a> / ${esc(l.kicker)}</div><span class="eyebrow">${esc(l.kicker)}</span><h1>${esc(l.h1)}</h1><p class="lede">${esc(l.body)}</p>
<div class="hero-btns" style="margin-bottom:20px">${textBtn('btn btn-primary', 'Text Byron')}${callBtn('btn btn-ghost', 'Call Byron')}${leadBtn('quote', 'Get My Best Quote', 'btn btn-ghost')}</div></div></div>
<div class="wrap">${syncBanner()}<div style="padding:22px 0 30px">${resultsBlock(f, res, '/' + l.slug)}</div>
<section class="block" style="margin-bottom:50px"><h2>More ways to shop Florence</h2><div class="chips">${others.map((o) => `<a class="chip" href="/${o.slug}">${esc(o.h1)}</a>`).join('')}<a class="chip" href="/inventory">All inventory</a></div>
<p class="muted small" style="margin:0">All units are sold by Shoals Outdoor Sports, ${esc(D.street)}, ${D.city}, ${D.region}. Byron Green is a sales representative at the Florence store.</p></section></div>`,
  });
}

async function unitPage(u) {
  const d = u.data || {};
  const k = d.keySpecs || {};
  const rel = await inv.related(u, 4);
  const feats = inv.unitFeatures(u);
  const imgs = u.images;
  const gallery = imgs.length ? `<div class="gal" data-gallery><div class="gal-main"><div class="gal-track" data-track tabindex="0" aria-label="Photo gallery">${imgs.map((src, i) => `<img src="${esc(i === 0 ? src : src.replace(/(\.\w+)$/, '_480px$1'))}" ${i === 0 ? 'fetchpriority="high"' : `data-full="${esc(src)}" loading="lazy"`} alt="${esc(u.title)} — photo ${i + 1} of ${imgs.length}" width="1200" height="900" decoding="async" data-ph>`).join('')}</div>
${imgs.length > 1 ? `<button class="gal-nav prev" data-prev aria-label="Previous photo">‹</button><button class="gal-nav next" data-next aria-label="Next photo">›</button><span class="gal-count"><span data-idx>1</span> / ${imgs.length}</span>` : ''}</div>
${imgs.length > 1 ? `<div class="thumbs">${imgs.map((src, i) => `<button data-go="${i}" aria-label="Photo ${i + 1}"${i === 0 ? ' aria-current="true"' : ''}><img src="${esc(src.replace(/(\.\w+)$/, '_480px$1'))}" alt="" loading="lazy" width="84" height="63"></button>`).join('')}</div>` : ''}</div>`
    : '<div class="gal-main"><span class="noimg">Photos coming soon — text Byron and he’ll send pictures.</span></div>';
  const kv = [['Stock #', u.stock_number], ['Condition', u.condition === 'Used' ? 'Pre-owned' : u.condition], ['Year', u.year], ['Make', u.make], ['Model', u.model], ['Type', u.model_type || u.vtype], ['Color', u.color], [d.vinLabel || 'VIN', u.vin], ['Seating', u.seats ? `${u.seats}` : null], ['Engine', k.displacement && /\d/.test(k.displacement) ? k.displacement : null], ['Horsepower', k.horsepower && /\d/.test(k.horsepower) ? k.horsepower : null], ['Ground clearance', k.groundClearance], ['Towing', k.towing ? k.towing.split(' · ')[0] : null], ['Payload', k.payload], ['Bed / box capacity', k.bedCapacity]].filter(([, v]) => v);
  const ld = {
    '@context': 'https://schema.org', '@type': ['Product', 'Vehicle'], name: u.title, sku: u.stock_number, url: config.siteUrl + u.url,
    brand: { '@type': 'Brand', name: u.make }, model: u.model, vehicleModelDate: String(u.year || ''), color: u.color || undefined,
    vehicleIdentificationNumber: d.vinLabel === 'VIN' ? u.vin : undefined, category: u.category || undefined,
    itemCondition: u.condition === 'Used' ? 'https://schema.org/UsedCondition' : 'https://schema.org/NewCondition',
    image: imgs.slice(0, 6), description: (d.description || '').slice(0, 500) || undefined,
  };
  if (u.price != null) {
    ld.offers = { '@type': 'Offer', price: u.price, priceCurrency: 'USD', url: config.siteUrl + u.url, itemCondition: ld.itemCondition, seller: dealerLd(), ...(u.stale ? {} : { availability: 'https://schema.org/InStock' }) };
  }
  const crumbsLd = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [['Home', '/'], ['Inventory', '/inventory'], [u.vtype, `/inventory${qs({ type: u.vtype })}`], [u.title, u.url]].map(([n, p], i) => ({ '@type': 'ListItem', position: i + 1, name: n, item: config.siteUrl + p })) };
  const body = `<div class="wrap"><div class="crumbs" style="padding-top:16px"><a href="/">Home</a> / <a href="/inventory">Inventory</a> / <a href="/inventory${esc(qs({ type: u.vtype }))}">${esc(u.vtype)}</a>${u.family ? ` / <a href="/inventory${esc(qs({ make: u.make, family: u.family }))}">${esc(u.make)} ${esc(u.family)}</a>` : ''}</div>
${u.stale ? '<div class="notice">This listing hasn’t been re-confirmed with the dealership in the last few hours. It may have sold — please check availability with Byron.</div>' : ''}
<div class="unit">
<div class="u-gal">${gallery}</div>
<div class="u-info">
${d.description || d.headline ? `<section class="block"><h2>About this ${esc(u.vtype === 'Side-by-Sides' ? 'side-by-side' : (u.vtype || 'unit').replace(/s$/, '').toLowerCase())}</h2>${d.priceNote ? `<p><b>${esc(d.priceNote)}</b></p>` : ''}<p class="pre">${esc(d.description || '')}</p>${u.note ? `<div class="notice info"><b>Byron’s note:</b> ${esc(u.note)}</div>` : ''}</section>` : (u.note ? `<section class="block"><div class="notice info"><b>Byron’s note:</b> ${esc(u.note)}</div></section>` : '')}
${feats.length || (d.features || []).length ? `<section class="block feat"><h2>Features &amp; equipment</h2>${feats.length ? `<ul class="specs" style="margin-bottom:12px">${feats.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}${(d.features || []).map((g) => `<div class="spec-group"><h3>${esc(g.group)}</h3><ul>${g.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div>`).join('')}</section>` : ''}
${(d.options || []).length ? `<section class="block feat"><h2>Options &amp; accessories</h2><ul>${d.options.map((o) => `<li>${esc(o)}</li>`).join('')}</ul></section>` : ''}
${(d.specs || []).length ? `<section class="block"><h2>Specifications</h2>${d.specs.map((g) => `<div class="spec-group"><h3>${esc(g.group)}</h3><table class="spec-table"><tbody>${g.rows.map(([a, b]) => `<tr><th scope="row">${esc(a)}</th><td>${esc(b)}</td></tr>`).join('')}</tbody></table></div>`).join('')}<p class="muted small" style="margin:14px 0 0">Specifications are as published by the dealership/manufacturer for this model and may vary by unit. Confirm anything critical with Byron.</p></section>` : ''}
</div>
<aside class="buy">
<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px"><span class="tag">${esc(u.condition === 'Used' ? 'Pre-owned' : 'New')}</span>${u.on_sale ? '<span class="tag sale">On Sale</span>' : ''}${u.badge ? `<span class="tag blue">${esc(u.badge)}</span>` : ''}</div>
<h1>${esc(u.title)}</h1>
<div style="margin-top:10px">${ui.priceHtml(u, true)}</div>
${u.price != null && u.msrp && u.msrp > u.price ? `<p class="small" style="margin:2px 0 0;color:var(--ok)">${money(u.msrp - u.price)} below retail price</p>` : ''}
${d.priceNote ? `<p class="small" style="margin:8px 0 0"><b>${esc(d.priceNote)}</b></p>` : ''}
${d.payment ? `<p class="muted small" style="margin:6px 0 0">Dealer payment estimate: ${esc(d.payment)}. Estimate only, with approved credit — ask Byron for real numbers.</p>` : ''}
<div style="margin-top:10px">${ui.availability(u)}</div>
<div class="buy-cta">${leadBtn('quote', 'Get My Best Quote', 'btn btn-primary wide', { unit: u })}${textBtn('btn btn-ghost', 'Text Byron', { unit: u })}${callBtn('btn btn-ghost', 'Call Byron', { unit: u })}${leadBtn('availability', 'Check Availability', 'btn btn-ghost', { unit: u })}${leadBtn('visit', 'Schedule a Visit', 'btn btn-ghost', { unit: u })}${leadBtn('financing', 'Ask About Financing', 'btn btn-ghost wide', { unit: u })}</div>
<dl class="kv">${kv.map(([a, b]) => `<dt>${esc(a)}</dt><dd>${esc(b)}</dd>`).join('')}</dl>
<div class="at">${ui.ICON.pin.replace('<svg', '<svg width="20" height="20" style="flex:none;color:var(--blue-hi)"')}<div><b style="color:var(--text)">Within reach — Byron can get to this unit easily</b><br>Sold by ${esc(D.locationName)}, ${esc(D.street)}, ${D.city}, ${D.region} ${D.zip}.<br>Your salesperson: Byron Green.</div></div>
</aside></div>
${rel.length ? `<section class="sec" style="padding-top:20px"><div class="sec-head"><div><h2>Related <span>Florence</span> inventory</h2><div class="slash"></div></div></div><div class="grid four">${rel.map((r) => card(r)).join('')}</div></section>` : ''}
</div>`;
  const loc = `Florence, AL`;
  return layout({
    path: u.url, canonical: u.url, unit: u, body, ogImage: imgs[0] || '',
    title: `${u.condition === 'Used' ? 'Used ' : ''}${u.title}${u.color ? ' ' + u.color : ''} for Sale in ${loc} | #${u.stock_number}`,
    description: `${u.condition === 'Used' ? 'Pre-owned' : 'New'} ${u.title}${u.color ? ' in ' + u.color : ''}${u.price != null ? ' — ' + money(u.price) : ''}. Stock #${u.stock_number}, available through Byron Green at Shoals Outdoor Sports in Florence, AL. Text or call Byron for availability and your best quote.`,
    head: jsonLd(ld) + jsonLd(crumbsLd),
  });
}

function about() {
  const c = content();
  return layout({
    path: '/about', canonical: '/about', title: 'About Byron Green | Powersports Sales at Shoals Outdoor Sports, Florence AL',
    description: 'Meet Byron Green — a sales professional with more than a decade of vehicle sales experience, now helping riders find the right Polaris, ATV, side-by-side or boat at Shoals Outdoor Sports in Florence, AL.',
    head: jsonLd(personLd()),
    body: `<div class="page-head"><div class="wrap"><span class="eyebrow">About Byron</span><h1>Byron Green</h1><p class="lede">Automotive and powersports sales professional · Shoals Outdoor Sports, Florence, Alabama</p></div></div>
<div class="wrap sec split">
<div class="prose">
<p>I’ve spent more than a decade helping people buy vehicles — first cars and trucks, and now the machines people buy for the fun part of life: side-by-sides, ATVs and boats. The product changed. The way I work didn’t.</p>
<p>When you reach out through this site, you get me. Not a call center, not a shared inbox, not whoever happens to be up next. One person who knows what you’re looking for and answers your texts.</p>
<h2>How I work</h2>
<ul>
<li><b>Personal service.</b> Same person from your first question to the day you load up.</li>
<li><b>Straightforward buying.</b> Clear numbers, explained line by line, before you commit to anything.</li>
<li><b>Product knowledge.</b> I’ll help you match the machine to how you’ll actually use it — and tell you when a less expensive one will do the job.</li>
<li><b>Direct communication.</b> Text, call or email, whatever suits you. I’ll send photos and walk-arounds.</li>
<li><b>No unnecessary pressure.</b> Take your time. Ask everything. If it isn’t right, it isn’t right.</li>
<li><b>Inventory within reach.</b> Everything on this site is a unit I can get to easily.</li>
</ul>
${c.aboutExtra ? `<p class="pre">${esc(c.aboutExtra)}</p>` : ''}
<h2>Who you’re buying from</h2>
<p>I’m a sales representative at <b>Shoals Outdoor Sports</b> in Florence, Alabama. I don’t own or operate the dealership, and RideWithByron.com isn’t a separate dealer. Every vehicle shown here belongs to Shoals Outdoor Sports, and every purchase — pricing, trade-ins, financing, paperwork and delivery — is completed through Shoals Outdoor Sports at ${esc(D.street)}, ${D.city}, ${D.region} ${D.zip}.</p>
<p>This site just makes it easy to see what’s within reach and to get hold of me directly.</p>
</div>
<div><div class="contact-card"><span class="eyebrow">Let’s find your ride</span><h2>Reach Byron directly</h2><div class="btns">${textBtn('btn btn-primary', 'Text Byron')}${callBtn('btn btn-ghost', 'Call Byron')}${leadBtn('quote', 'Get My Best Quote', 'btn btn-ghost')}${leadBtn('visit', 'Schedule a Visit', 'btn btn-ghost')}</div></div>
<div class="map-card" style="margin-top:16px"><h3>${esc(D.locationName)}</h3><p style="margin:8px 0">${esc(D.street)}<br>${D.city}, ${D.region} ${D.zip}</p><a class="btn btn-ghost btn-sm" href="${D.mapsUrl}" target="_blank" rel="noopener">Get Directions</a> <a class="btn btn-primary btn-sm" href="/inventory">Shop Inventory</a></div></div>
</div>`,
  });
}

function contact({ intent = 'question', unit = null, errors = {}, values = {}, sent = false } = {}) {
  const c = content();
  return layout({
    path: '/contact', canonical: '/contact', noindex: !!unit || sent,
    title: 'Contact Byron Green | Shoals Outdoor Sports Florence, AL', description: 'Text, call or message Byron Green directly about any unit at Shoals Outdoor Sports in Florence, Alabama. Get your best quote, check availability or schedule a visit.',
    body: `<div class="page-head"><div class="wrap"><span class="eyebrow">Direct to Byron</span><h1>${esc(sent ? 'Got it — thank you' : INTENTS[intent] || 'Contact Byron')}</h1><p class="lede">${sent ? 'Your message went straight to Byron. He’ll reach out personally, usually the same business day.' : 'Your message goes to Byron Green personally — not the dealership’s general inbox.'}</p></div></div>
<div class="wrap sec split">
<div class="block" style="margin-top:0">${sent ? `<div class="done"><h3>Message sent</h3><p>Byron has your details${unit ? ` and knows you’re asking about the <b>${esc(unit.title)}</b> (Stock #${esc(unit.stock_number)})` : ''}.</p><a class="btn btn-primary" href="/inventory">Keep shopping</a></div>` : leadForm({ intent, unit, errors, values, inline: true })}</div>
<div><div class="contact-card"><h2>Faster by phone?</h2><p class="lede" style="margin-top:8px">${c.byronPhone ? `Call or text Byron at <b>${esc(ui.fmtPhone(c.byronPhone))}</b>.` : 'Leave your number and Byron will call or text you back.'}</p><div class="btns">${textBtn('btn btn-primary', 'Text Byron', { unit })}${callBtn('btn btn-ghost', 'Call Byron', { unit })}</div></div>
<div class="map-card" style="margin-top:16px"><h3>Visit the Florence store</h3><p style="margin:8px 0"><b>${esc(D.locationName)}</b><br>${esc(D.street)}<br>${D.city}, ${D.region} ${D.zip}</p><table class="hours"><tbody>${c.hours.map(([d, h]) => `<tr><td>${esc(d)}</td><td>${esc(h)}</td></tr>`).join('')}</tbody></table><p style="margin-top:12px"><a class="btn btn-ghost btn-sm" href="${D.mapsUrl}" target="_blank" rel="noopener">Get Directions</a></p></div></div>
</div>`,
  });
}

function financing() {
  return layout({
    path: '/financing', canonical: '/financing', title: 'Powersports Financing Questions | Ride With Byron — Florence, AL',
    description: 'Have questions about financing a Polaris, ATV, side-by-side or boat at Shoals Outdoor Sports in Florence, AL? Ask Byron Green directly — no obligation.',
    body: `<div class="page-head"><div class="wrap"><span class="eyebrow">Financing</span><h1>Ask about financing</h1><p class="lede">Payments, terms, trade-ins, down payment — ask Byron anything before you fill out a single form.</p></div></div>
<div class="wrap sec split"><div class="prose">
<h2 style="margin-top:0">How it works</h2>
<ul><li><b>Start with a conversation.</b> Tell Byron which unit you like and roughly where you want your payment. He’ll tell you what’s realistic.</li>
<li><b>Financing is arranged by the dealership.</b> Credit applications, lender approvals, rates and terms are all handled by Shoals Outdoor Sports’ finance department. This website does not collect credit applications or sensitive financial information.</li>
<li><b>Manufacturer offers.</b> Promotional rates and rebates change often and depend on the model and your credit. Byron will tell you what currently applies to the unit you’re looking at.</li>
<li><b>Trades welcome.</b> Tell Byron what you have and he’ll get it appraised.</li></ul>
<p class="muted small">Payment figures shown on vehicle pages are dealer-published estimates, not offers of credit. All financing is subject to credit approval by the lender.</p></div>
<div class="block" style="margin-top:0"><h2>Ask Byron about financing</h2>${leadForm({ intent: 'financing', inline: true })}</div></div>`,
  });
}

function privacy() {
  return layout({
    path: '/privacy', canonical: '/privacy', title: 'Privacy Notice | RideWithByron.com', description: 'How RideWithByron.com handles the information you share with Byron Green.',
    body: `<div class="page-head"><div class="wrap"><h1>Privacy notice</h1></div></div><div class="wrap sec prose">
<p>RideWithByron.com is operated by Byron Green, a sales representative at Shoals Outdoor Sports in Florence, Alabama.</p>
<h2>What we collect</h2><p>When you submit a form: your name, phone number, email (if you give it), your message, the vehicle you asked about, and how you found the site (for example an ad campaign tag or the referring website). We collect only what Byron needs to respond to you.</p>
<h2>How it’s used</h2><p>Your inquiry is sent to Byron and stored in his customer-relationship system so he can follow up. If you move forward with a purchase, your information is shared with Shoals Outdoor Sports to complete the sale. It is not sold.</p>
<h2>Calls and texts</h2><p>By submitting a form you agree Byron may contact you by phone, text or email about your inquiry. Message and data rates may apply. Reply STOP to any text to opt out. Consent is not a condition of purchase.</p>
<h2>Cookies and measurement</h2><p>The site remembers how you first arrived (stored in your browser) so Byron knows which advertising works. Google and Meta measurement tags, where used, load only if you allow them in the cookie prompt. Basic page-view counts are kept without cookies and without personal information.</p>
<h2>Your choices</h2><p>To see, correct or delete the information you’ve shared, <a href="/contact">contact Byron</a>.</p></div>`,
  });
}

function aboutSite() {
  const h = syncHealth();
  return layout({
    path: '/about-this-site', canonical: '/about-this-site', title: 'About This Site & Inventory Data | RideWithByron.com', description: 'How RideWithByron.com keeps Florence inventory accurate.',
    body: `<div class="page-head"><div class="wrap"><h1>About this site</h1></div></div><div class="wrap sec prose">
<p>RideWithByron.com shows inventory published by Shoals Outdoor Sports for its Florence, Alabama store. A unit appears here only when the dealership lists it as <b>in stock</b> under its <b>Florence</b> store — the units Byron can get to easily. Units listed under other Shoals Outdoor Sports locations are not shown.</p>
<p>Listings are re-checked about every ${config.source.intervalMinutes} minutes. Last successful check: <b>${h.lastSuccess ? esc(new Date(h.lastSuccess).toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' })) + ' CT' : 'not yet completed'}</b>. If the dealership’s site can’t be reached, listings are marked as needing re-verification and are hidden after ${config.source.hideAfterHours} hours.</p>
<h2>Automated access</h2><p>Our inventory checker identifies itself as <code>RideWithByronInventorySync</code>, requests one page at a time with a pause between requests, follows robots.txt, and stops if the site asks it to. Site administrators with questions can <a href="/contact">contact Byron</a>.</p></div>`,
  });
}

function notFound() {
  return layout({ path: '/404', title: 'Page not found | RideWithByron.com', noindex: true, body: `<div class="wrap sec" style="text-align:center"><span class="eyebrow">404</span><h1>That trail ends here</h1><p class="lede" style="margin:14px auto 22px">The page you’re looking for isn’t available. If it was a vehicle, it may have sold.</p><div class="hero-btns" style="justify-content:center"><a class="btn btn-primary" href="/inventory">Shop Inventory</a>${textBtn('btn btn-ghost', 'Text Byron')}</div></div>` });
}

export { home, inventory, landing, unitPage, about, contact, financing, privacy, aboutSite, notFound, qs };
