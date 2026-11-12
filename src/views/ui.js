// Shared server-rendered UI: layout, logo, vehicle cards, lead form.
import { config } from '../config.js';
import { getSetting } from '../db.js';
import { INTENTS, CONSENT_TEXT } from '../leads.js';

/** Per-request values that templates need but cannot await (set by the Worker before rendering). */
export const reqState = { formToken: '' };
const formToken = () => reqState.formToken;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (n == null ? null : '$' + Number(n).toLocaleString('en-US'));
const jsonLd = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;

// Bump when public/css or public/js change, so browsers fetch the new files.
const ver = '3';

const DEFAULT_CONTENT = {
  byronPhone: '',       // Byron's direct line, e.g. 256-555-0123. Until set, call/text buttons open the request form.
  byronEmail: '',
  heroImage: '',        // optional licensed hero photo URL
  showNoFees: true,     // mirrors the policy published on the dealership's own site
  aboutExtra: '',
  testimonials: [],     // only genuine, approved reviews: [{quote,name,detail}]
  hours: config.dealership.hours,
};
const content = () => ({ ...DEFAULT_CONTENT, ...(getSetting('content', {}) || {}) });
const telHref = (p) => 'tel:+1' + p.replace(/\D/g, '').slice(-10);
const fmtPhone = (p) => { const d = p.replace(/\D/g, '').slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p; };

const ICON = {
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>',
  msg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.2A8.4 8.4 0 1 1 21 11.5z"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  menu: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg>',
};

/** Original wordmark: mountain ridge, italic chrome/blue type, speed swoosh, tread ticks. */
function logo(id = 'lg', compact = false) {
  return `<svg viewBox="0 0 430 92" role="img" aria-label="RideWithByron.com" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="${id}c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset=".55" stop-color="#e9eef4"/><stop offset="1" stop-color="#9aa6b5"/></linearGradient>
<linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6fc0ff"/><stop offset=".5" stop-color="#1488ff"/><stop offset="1" stop-color="#0a5fd0"/></linearGradient>
<linearGradient id="${id}s" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#1488ff" stop-opacity="0"/><stop offset=".25" stop-color="#1488ff"/><stop offset="1" stop-color="#52adff"/></linearGradient></defs>
<path d="M118 34 150 14l13 9 24-21 26 19 14-8 34 21h-12l-22-12-13 8-27-19-22 20-15-9-20 12z" fill="#fff"/>
<path d="M187 2l-10 16 9-3 5 8 4-9 9 4z" fill="#cfd8e3"/>
<path d="M8 72C30 40 96 24 150 26" fill="none" stroke="url(#${id}s)" stroke-width="3.5" stroke-linecap="round"/>
<text x="14" y="66" font-family="'Barlow Condensed','Arial Narrow',Impact,sans-serif" font-style="italic" font-weight="800" font-size="50" letter-spacing=".5"><tspan fill="url(#${id}c)">RIDEWITH</tspan><tspan fill="url(#${id}b)">BYRON</tspan><tspan fill="url(#${id}c)" font-size="30">.COM</tspan></text>
<path d="M20 76h300l-6 5H14z" fill="url(#${id}b)"/>
<g fill="#1488ff"><path d="M330 76h12l-5 5h-12zM348 76h12l-5 5h-12zM366 76h12l-5 5h-12zM384 76h10l-5 5h-10zM400 76h8l-5 5h-8z" opacity=".85"/></g>
${compact ? '' : `<text x="16" y="91" font-family="'Barlow Condensed','Arial Narrow',sans-serif" font-weight="700" font-size="9.5" letter-spacing="3.2" fill="#c9d1db">POWERSPORTS  ·  FLORENCE, AL  ·  SHOALS OUTDOOR SPORTS</text>`}
</svg>`.replace('viewBox="0 0 430 92"', compact ? 'viewBox="0 0 430 84"' : 'viewBox="0 0 430 92"');
}

/** Call / text controls. Direct tel:/sms: when Byron's number is configured, request form otherwise. */
function callBtn(cls = 'btn btn-ghost', label = 'Call Byron', ctx = {}) {
  const c = content();
  if (c.byronPhone) return `<a class="${cls}" href="${telHref(c.byronPhone)}" data-track="call">${ICON.phone}<span>${esc(label)}</span></a>`;
  return leadBtn('question', label, cls, { ...ctx, icon: ICON.phone, title: 'Request a call from Byron' });
}
function textBtn(cls = 'btn btn-ghost', label = 'Text Byron', ctx = {}) {
  const c = content();
  if (c.byronPhone) {
    const body = ctx.unit ? `Hi Byron, I'm interested in the ${ctx.unit.title} (Stock #${ctx.unit.stock_number}).` : 'Hi Byron, I found you on RideWithByron.com.';
    return `<a class="${cls}" href="sms:+1${c.byronPhone.replace(/\D/g, '').slice(-10)}?&body=${encodeURIComponent(body)}" data-track="text">${ICON.msg}<span>${esc(label)}</span></a>`;
  }
  return leadBtn('text', label, cls, { ...ctx, icon: ICON.msg });
}
function leadBtn(intent, label, cls = 'btn btn-primary', ctx = {}) {
  const u = ctx.unit;
  const href = `/contact?intent=${intent}${u ? '&unit=' + u.guid : ''}`; // works without JavaScript too
  return `<a class="${cls}" href="${href}" data-lead="${intent}"${ctx.title ? ` data-title="${esc(ctx.title)}"` : ''}${u ? ` data-guid="${u.guid}" data-vehicle="${esc(u.title)}" data-stock="${esc(u.stock_number)}"` : ''}>${ctx.icon || ''}<span>${esc(label)}</span></a>`;
}

function availability(u) {
  if (u.stale) return `<span class="avail"><span class="dot warn"></span>Availability being re-verified — ask Byron</span>`;
  return `<span class="avail"><span class="dot"></span>In stock · verified ${ago(u.last_verified)}</span>`;
}
function ago(iso) {
  if (!iso) return 'never';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 2) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hr${h === 1 ? '' : 's'} ago`;
  return `${Math.round(h / 24)} days ago`;
}
function priceHtml(u, big = false) {
  if (u.price != null) {
    return `<div class="price-row"><span class="price">${money(u.price)}</span>${u.msrp && u.msrp > u.price ? `<span class="was">${money(u.msrp)}</span>` : ''}</div>`;
  }
  return `<div class="price-row"><span class="price call">${big ? 'Ask Byron for today’s price' : 'Call for price'}</span>${u.msrp ? `<span class="muted small">MSRP ${money(u.msrp)}</span>` : ''}</div>`;
}
function quickSpecs(u) {
  const k = (u.data && u.data.keySpecs) || {};
  const short = (s, n = 26) => (s && /\d/.test(s) ? s.split(' · ')[0].replace(/\s*\(.*?\)/g, '').slice(0, n) : null);
  const out = [];
  if (u.color) out.push(u.color);
  if (u.seats) out.push(`${u.seats} seats`);
  if (short(k.displacement)) out.push(short(k.displacement));
  if (short(k.horsepower)) out.push(short(k.horsepower));
  if (short(k.towing)) out.push('Tows ' + short(k.towing, 14));
  if (!out.length && u.model_type) out.push(u.model_type);
  return out.slice(0, 4);
}

function card(u, { eager = false } = {}) {
  const tags = [];
  if (u.badge) tags.push(`<span class="tag blue">${esc(u.badge)}</span>`);
  if (u.on_sale) tags.push('<span class="tag sale">On Sale</span>');
  if (u.isNewArrival && !u.badge) tags.push('<span class="tag blue">Just In</span>');
  tags.push(`<span class="tag">${esc(u.condition || '')}</span>`);
  return `<article class="card">
<a class="card-img" href="${u.url}" aria-label="${esc(u.title)}">${u.thumb ? `<img src="${esc(u.thumb)}" alt="${esc(u.title)}${u.color ? ' in ' + esc(u.color) : ''} at Shoals Outdoor Sports Florence" width="480" height="360" loading="${eager ? 'eager' : 'lazy'}" decoding="async" data-ph>` : '<span class="noimg">Photos coming soon — ask Byron for pictures</span>'}<span class="tags">${tags.join('')}</span></a>
<div class="card-body">
<a class="card-title" href="${u.url}">${esc(u.title)}</a>
${priceHtml(u)}
<ul class="specs">${quickSpecs(u).map((s) => `<li>${esc(s)}</li>`).join('')}<li>Stock #${esc(u.stock_number)}</li></ul>
${availability(u)}
</div>
<div class="card-cta"><a href="${u.url}">View Details</a>${leadBtn('question', 'Ask Byron', '', { unit: u })}${leadBtn('quote', 'Get a Quote', '', { unit: u })}</div>
</article>`;
}

/** The lead form (used inline on /contact and inside the dialog). */
function leadForm({ intent = 'question', unit = null, errors = {}, values = {}, inline = false } = {}) {
  const e = (k) => (errors[k] ? `<span class="err">${esc(errors[k])}</span>` : '');
  return `<form class="form" method="post" action="/lead" data-leadform novalidate>
<input type="hidden" name="_t" value="${formToken()}"><input type="hidden" name="attribution" value=""><input type="hidden" name="page_url" value="">
<input type="hidden" name="unit" value="${unit ? unit.guid : ''}">
<div class="veh" data-veh ${unit ? '' : 'hidden'}>Vehicle: <b data-veh-name>${unit ? esc(unit.title) : ''}</b> <span class="muted">· Stock #<span data-veh-stock>${unit ? esc(unit.stock_number) : ''}</span></span></div>
<label class="f">I’d like to<select name="intent">${Object.entries(INTENTS).map(([k, v]) => `<option value="${k}"${k === intent ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
<label class="f">Name<input name="name" autocomplete="name" required maxlength="80" value="${esc(values.name)}">${e('name')}</label>
<label class="f">Mobile phone<input name="phone" type="tel" inputmode="tel" autocomplete="tel" required maxlength="30" value="${esc(values.phone)}">${e('phone')}</label>
<label class="f">Email <span style="text-transform:none;letter-spacing:0">(optional)</span><input name="email" type="email" autocomplete="email" maxlength="120" value="${esc(values.email)}">${e('email')}</label>
<label class="f" data-when ${intent === 'visit' ? '' : 'hidden'}>Preferred day &amp; time<input name="preferred_time" maxlength="80" placeholder="e.g. Saturday morning" value="${esc(values.preferred_time)}"></label>
<label class="f">Message <span style="text-transform:none;letter-spacing:0">(optional)</span><textarea name="message" maxlength="1500" placeholder="Trade-in, questions, what you’re looking for…">${esc(values.message)}</textarea></label>
<div class="hp" aria-hidden="true"><label>Company<input name="company" tabindex="-1" autocomplete="off"></label></div>
<label class="check"><input type="checkbox" name="consent" value="yes" required><span>${esc(CONSENT_TEXT)} See our <a href="/privacy">privacy notice</a>.${e('consent') ? '<br>' + e('consent') : ''}</span></label>
<div class="err" data-form-error role="alert"></div>
<button class="btn btn-primary btn-block" type="submit">Send to Byron</button>
<p class="muted small" style="margin:0;text-align:center">Goes straight to Byron Green — not a call center.</p>
</form>`;
}

function layout({ title, description, canonical, body, path: reqPath = '/', noindex = false, head = '', ogImage = '', unit = null, bare = false }) {
  const c = content();
  const a = config.analytics;
  const hasTags = a.ga4 || a.googleAds || a.metaPixel;
  const nav = [['/inventory', 'Inventory'], ['/polaris-ranger-for-sale-florence-al', 'Rangers'], ['/side-by-sides-for-sale-north-alabama', 'Side-by-Sides'], ['/about', 'About Byron'], ['/financing', 'Financing'], ['/contact', 'Contact']];
  const cur = (href) => (reqPath === href ? ' aria-current="page"' : '');
  const canon = canonical ? config.siteUrl + canonical : null;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
${description ? `<meta name="description" content="${esc(description)}">` : ''}
${noindex ? '<meta name="robots" content="noindex,follow">' : '<meta name="robots" content="index,follow,max-image-preview:large">'}
${canon ? `<link rel="canonical" href="${esc(canon)}">` : ''}
<meta name="theme-color" content="#07080a">
<meta property="og:site_name" content="RideWithByron.com"><meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}">
${description ? `<meta property="og:description" content="${esc(description)}">` : ''}${canon ? `<meta property="og:url" content="${esc(canon)}">` : ''}${ogImage ? `<meta property="og:image" content="${esc(ogImage)}"><meta name="twitter:card" content="summary_large_image">` : ''}
<link rel="preload" href="/fonts/barlow-condensed-latin-800-italic.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/css/site.css?v=${ver}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${unit || /inventory|^\/$/.test(reqPath) ? '<link rel="preconnect" href="https://cdpcdn.dx1app.com" crossorigin>' : ''}
${head}
</head><body>
<a class="sr" href="#main">Skip to content</a>
${bare ? '' : `<header class="top"><div class="wrap">
<a class="logo" href="/" aria-label="RideWithByron.com home">${logo('h', true)}</a>
<nav class="nav" aria-label="Main">${nav.map(([h, l]) => `<a href="${h}"${cur(h)}>${l}</a>`).join('')}</nav>
<div class="top-cta">${textBtn('btn btn-primary btn-sm hide-m', 'Text Byron')}<button class="menu-btn" aria-label="Menu" aria-expanded="false" data-menu>${ICON.menu}</button></div>
</div><nav class="mnav" aria-label="Mobile" data-mnav>${nav.map(([h, l]) => `<a href="${h}">${l}</a>`).join('')}<a href="/contact?intent=visit">Schedule a Visit</a></nav></header>`}
<main id="main">${body}</main>
${bare ? '' : `<footer class="foot"><div class="wrap">
<div class="foot-grid">
<div><div style="max-width:260px">${logo('f')}</div><p style="margin-top:12px">Find Your Ride. Fuel Your Adventure.<br>Byron Green — Sales, Shoals Outdoor Sports, Florence, Alabama.</p></div>
<div><h4>Shop</h4><ul><li><a href="/inventory">All Florence inventory</a></li><li><a href="/inventory?condition=New">New</a></li><li><a href="/inventory?condition=Used">Pre-owned</a></li><li><a href="/polaris-dealer-florence-al">Polaris in Florence</a></li><li><a href="/atvs-for-sale-florence-alabama">ATVs</a></li><li><a href="/polaris-rzr-for-sale-huntsville-al">Polaris RZR</a></li></ul></div>
<div><h4>Byron</h4><ul><li><a href="/about">About Byron</a></li><li><a href="/financing">Financing questions</a></li><li><a href="/contact?intent=visit">Schedule a visit</a></li><li><a href="/contact">Contact</a></li>${c.byronPhone ? `<li><a href="${telHref(c.byronPhone)}" data-track="call">${esc(fmtPhone(c.byronPhone))}</a></li>` : ''}</ul></div>
<div><h4>Visit</h4><ul><li>${esc(config.dealership.locationName)}</li><li>${esc(config.dealership.street)}<br>${esc(config.dealership.city)}, ${config.dealership.region} ${config.dealership.zip}</li><li><a href="${config.dealership.mapsUrl}" rel="noopener" target="_blank">Get directions</a></li><li><a href="/privacy">Privacy</a> · <a href="/about-this-site">About this site</a></li></ul></div>
</div>
<p class="disclose">RideWithByron.com is the personal sales website of Byron Green, a sales representative at Shoals Outdoor Sports in Florence, Alabama. It is not a dealership. All vehicles shown are owned and offered for sale by Shoals Outdoor Sports, and every purchase, price, trade, financing arrangement and delivery is completed through Shoals Outdoor Sports. Inventory, prices and availability are read from the dealership’s published Florence listings and re-verified regularly, but units sell quickly and errors can occur — please confirm details with Byron before you travel. Prices exclude tax, title and registration unless stated. Polaris®, RANGER®, RZR®, GENERAL®, Sportsman® and XPEDITION® are trademarks of Polaris Industries Inc.; other brand names belong to their owners.</p>
<p class="small" style="margin:10px 0 0;color:var(--dim)">© ${new Date().getFullYear()} Byron Green. ${hasTags ? '<a href="#" data-consent-open>Cookie choices</a>' : ''}</p>
</div></footer>
<div class="mbar" role="group" aria-label="Contact Byron">${callBtn('btn btn-ghost', 'Call', { unit })}${textBtn('btn btn-ghost', 'Text', { unit })}${leadBtn('quote', 'Best Quote', 'btn btn-primary', { unit })}</div>
<dialog class="lead" data-dialog aria-labelledby="dlg-title"><div class="dlg-head"><div><span class="eyebrow">Direct to Byron</span><h2 id="dlg-title" data-dlg-title>Ask Byron</h2></div><button class="x" data-close aria-label="Close">×</button></div><div class="dlg-body" data-dlg-body>${leadForm({})}</div></dialog>
${hasTags ? `<div class="consent" data-consent role="dialog" aria-label="Cookie choices"><span>This site can use Google and Meta measurement cookies to understand which ads bring visitors here. They load only if you allow them.</span><div><button class="btn btn-primary btn-sm" data-consent-yes>Allow</button><button class="btn btn-ghost btn-sm" data-consent-no>No thanks</button></div></div>` : ''}`}
<script type="application/json" id="rwb-config">${JSON.stringify({ ga4: a.ga4, ads: a.googleAds, adsLead: a.googleAdsLeadLabel, pixel: a.metaPixel, intents: INTENTS }).replace(/</g, '\\u003c')}</script>
<script src="/js/site.js?v=${ver}" defer></script>
</body></html>`;
}

export { esc, money, jsonLd, layout, logo, card, leadForm, leadBtn, callBtn, textBtn, availability, priceHtml, quickSpecs, ago, content, DEFAULT_CONTENT, ICON, telHref, fmtPhone };
