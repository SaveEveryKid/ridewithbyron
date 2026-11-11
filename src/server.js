'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const { db, now, getSetting, setSetting, logError } = require('./db');
const inv = require('./inventory');
const leads = require('./leads');
const sec = require('./security');
const sync = require('./sync/engine');
const pages = require('./views/pages');
const admin = require('./views/admin');
const { LANDING, bySlug } = require('./seo');
const { DEFAULT_CONTENT } = require('./views/ui');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY || 1)); // behind one reverse proxy / load balancer

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", 'https://www.googletagmanager.com', 'https://connect.facebook.net'],
      'img-src': ["'self'", 'data:', 'https://cdpcdn.dx1app.com', 'https://cdn.dx1app.com', 'https://www.google-analytics.com', 'https://www.facebook.com', 'https://www.googletagmanager.com', 'https:'],
      'connect-src': ["'self'", 'https://www.google-analytics.com', 'https://*.google-analytics.com', 'https://www.googletagmanager.com', 'https://www.facebook.com', 'https://connect.facebook.net', 'https://*.doubleclick.net', 'https://www.google.com'],
      'style-src': ["'self'", "'unsafe-inline'"],
      'frame-ancestors': ["'none'"],
      'form-action': ["'self'"],
      'upgrade-insecure-requests': config.isProd ? [] : null,
    },
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  crossOriginEmbedderPolicy: false,
  hsts: config.isProd,
}));
app.use(compression());

// Canonical host + https in production
app.use((req, res, next) => {
  if (!config.isProd) return next();
  const want = new URL(config.siteUrl);
  if (req.hostname !== want.hostname || req.protocol !== 'https') return res.redirect(301, config.siteUrl + req.originalUrl);
  next();
});

app.use('/fonts', express.static(path.join(__dirname, '..', 'node_modules', '@fontsource', 'barlow-condensed', 'files'), { maxAge: '365d', immutable: true }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProd ? '30d' : 0 }));
app.use(express.json({ limit: '20kb', type: ['application/json', 'text/plain'] }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));

const html = (res, markup, status = 200) => res.status(status).type('html').set('Cache-Control', 'no-cache').send(markup);
const BOT = /bot|crawl|spider|slurp|preview|monitor|headless|lighthouse|curl|wget|python|scrapy|facebookexternalhit/i;

// ---------------- public pages
app.get('/', (req, res) => html(res, pages.home()));
app.get('/inventory', (req, res) => html(res, pages.inventory(req.query)));
app.get('/inventory/:slug', (req, res) => {
  const u = inv.getBySlug(String(req.params.slug).slice(0, 160));
  if (u && inv.isPublic(u)) return html(res, pages.unitPage(u));
  if (u) {
    // Sold / removed / hidden: permanent redirect to the closest live category so links and ads don't dead-end.
    const p = new URLSearchParams();
    if (u.make) p.set('make', u.make);
    if (u.family) p.set('family', u.family); else if (u.vtype) p.set('type', u.vtype);
    const stillTemporary = u.status === 'active'; // only hidden by admin or awaiting re-verification
    return res.redirect(stillTemporary ? 302 : 301, '/inventory?' + p.toString());
  }
  html(res, pages.notFound(), 404);
});
app.get('/about', (req, res) => html(res, pages.about()));
app.get('/financing', (req, res) => html(res, pages.financing()));
app.get('/privacy', (req, res) => html(res, pages.privacy()));
app.get('/about-this-site', (req, res) => html(res, pages.aboutSite()));
app.get('/contact', (req, res) => {
  const unit = typeof req.query.unit === 'string' ? inv.getByGuid(req.query.unit.slice(0, 36)) : null;
  html(res, pages.contact({ intent: leads.INTENTS[req.query.intent] ? req.query.intent : 'question', unit: unit && inv.isPublic(unit) ? unit : null }));
});
app.get('/visit', (req, res) => res.redirect(301, '/contact?intent=visit'));
for (const l of LANDING) app.get('/' + l.slug, (req, res) => html(res, pages.landing(l, req.query)));

app.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nDisallow: /lead\nDisallow: /contact?\n\nSitemap: ${config.siteUrl}/sitemap.xml\n`));
app.get('/sitemap.xml', (req, res) => {
  const day = new Date().toISOString().slice(0, 10);
  const urls = [['/', day, '1.0'], ['/inventory', day, '0.9'], ...LANDING.map((l) => ['/' + l.slug, day, '0.8']), ['/about', null, '0.6'], ['/financing', null, '0.5'], ['/contact', null, '0.5'],
    ...inv.allPublic().map((u) => [u.url, (u.last_changed || u.last_verified || '').slice(0, 10), '0.7'])];
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(([p, lm, pr]) => `<url><loc>${config.siteUrl}${p}</loc>${lm ? `<lastmod>${lm}</lastmod>` : ''}<priority>${pr}</priority></url>`).join('\n')}\n</urlset>\n`);
});
app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.svg'));
app.get('/healthz', (req, res) => { const h = sync.syncHealth(); res.json({ ok: true, lastSuccessfulSync: h.lastSuccess, stale: h.stale, paused: h.paused }); });

// ---------------- events (first-party, cookie-less)
const eventLimiter = rateLimit({ windowMs: 60000, limit: 120, standardHeaders: true, legacyHeaders: false });
app.post('/api/event', eventLimiter, (req, res) => {
  res.status(204).end();
  try {
    const b = req.body || {};
    if (BOT.test(req.get('user-agent') || '')) return;
    const type = ['view', 'call', 'text', 'lead_open'].includes(b.type) ? b.type : null;
    if (!type) return;
    const guid = typeof b.guid === 'string' && /^[0-9a-f-]{36}$/.test(b.guid) ? b.guid : null;
    const source = leads.classifySource(leads.sanitizeAttribution(b.attribution));
    db.prepare('INSERT INTO events(at,day,type,path,unit_guid,source,visitor) VALUES(?,?,?,?,?,?,?)').run(now(), now().slice(0, 10), type, String(b.path || '').slice(0, 200), guid, source, sec.hashIp(req.ip));
  } catch (e) { logError('event', e); }
});

// ---------------- leads
const leadLimiter = rateLimit({ windowMs: 15 * 60000, limit: 8, standardHeaders: true, legacyHeaders: false, message: { ok: false, message: 'Too many requests. Please call or text Byron instead.' } });
app.post('/lead', leadLimiter, (req, res) => {
  const b = req.body || {};
  const wantsJson = (req.get('accept') || '').includes('application/json');
  const unit = typeof b.unit === 'string' && b.unit ? inv.getByGuid(b.unit.slice(0, 36)) : null;
  const fail = (status, errors, message) => (wantsJson ? res.status(status).json({ ok: false, errors, message })
    : html(res, pages.contact({ intent: b.intent, unit, errors: { ...errors, ...(message ? { consent: message } : {}) }, values: b }), status));
  // Spam controls: honeypot, signed render-time token, rate limit. Bots get a quiet success.
  if (b.company) return wantsJson ? res.json({ ok: true }) : html(res, pages.contact({ sent: true }));
  const tokenProblem = sec.checkFormToken(b._t);
  if (tokenProblem === 'expired') return fail(400, {}, 'This form expired. Please reload the page and try again.');
  if (tokenProblem === 'too-fast') return fail(400, {}, 'Please take a moment to review your details, then send again.');
  const v = leads.validateLead(b);
  if (!v.ok) return fail(422, v.errors);
  try {
    const saved = leads.saveLead(v.lead, { unit, attribution: b.attribution, pageUrl: b.page_url, ipHash: sec.hashIp(req.ip), userAgent: req.get('user-agent') });
    if (!saved.duplicate) leads.deliverLead(saved.id).catch((e) => logError('lead-delivery', e));
    return wantsJson ? res.json({ ok: true }) : html(res, pages.contact({ sent: true, unit }));
  } catch (e) {
    logError('lead-save', e);
    return fail(500, {}, 'We couldn’t save your message. Please call or text Byron directly.');
  }
});

// ---------------- admin
const loginLimiter = rateLimit({ windowMs: 15 * 60000, limit: 8, standardHeaders: true, legacyHeaders: false, message: 'Too many sign-in attempts. Try again in 15 minutes.' });
app.get('/admin/login', (req, res) => (sec.getSession(req) ? res.redirect('/admin') : html(res, admin.login())));
app.post('/admin/login', loginLimiter, (req, res) => {
  if (config.adminPasswordHash && sec.checkPassword((req.body || {}).password || '', config.adminPasswordHash)) { sec.setSession(res); return res.redirect('/admin'); }
  logError('admin-login', new Error('Failed admin sign-in attempt'), `ip ${sec.hashIp(req.ip)}`);
  html(res, admin.login('Incorrect password.'), 401);
});
const A = express.Router();
A.use(sec.requireAdmin);
const flash = (req) => (typeof req.query.m === 'string' ? req.query.m.slice(0, 200) : '');
A.get('/', (req, res) => html(res, admin.overview(req.admin.csrf, flash(req))));
A.get('/inventory', (req, res) => html(res, admin.inventoryAdmin(req.admin.csrf, req.query)));
A.get('/leads', (req, res) => html(res, admin.leadsAdmin(req.admin.csrf, req.query, flash(req))));
A.get('/traffic', (req, res) => html(res, admin.traffic(req.admin.csrf)));
A.get('/content', (req, res) => html(res, admin.contentAdmin(req.admin.csrf, flash(req))));
A.get('/logs', (req, res) => html(res, admin.logs(req.admin.csrf, req.query)));
A.post('/logout', (req, res) => { sec.clearSession(res); res.redirect('/admin/login'); });
A.post('/sync/pause', (req, res) => { setSetting('sync_paused', true); res.redirect('/admin?m=' + encodeURIComponent('Synchronization suspended.')); });
A.post('/sync/resume', (req, res) => { setSetting('sync_paused', false); setSetting('sync_blocked_until', null); res.redirect('/admin?m=' + encodeURIComponent('Synchronization resumed.')); });
A.post('/sync/run', (req, res) => {
  if (getSetting('sync_paused', false)) return res.redirect('/admin?m=' + encodeURIComponent('Synchronization is suspended — resume it first.'));
  sync.runSync({ trigger: 'manual' }).catch((e) => logError('manual-sync', e));
  res.redirect('/admin?m=' + encodeURIComponent('Sync started. Refresh in a few minutes for results.'));
});
A.post('/unit/:guid', (req, res) => {
  const g = req.params.guid;
  if (!/^[0-9a-f-]{36}$/.test(g) || !db.prepare('SELECT 1 FROM units WHERE guid=?').get(g)) return res.status(404).send('Unknown unit');
  const b = req.body;
  db.prepare('INSERT OR IGNORE INTO overrides(guid) VALUES(?)').run(g);
  if (b.featured !== undefined) db.prepare('UPDATE overrides SET featured=?, updated_at=? WHERE guid=?').run(b.featured === '1' ? 1 : 0, now(), g);
  if (b.hidden !== undefined) db.prepare('UPDATE overrides SET hidden=?, updated_at=? WHERE guid=?').run(b.hidden === '1' ? 1 : 0, now(), g);
  if (b.save) db.prepare('UPDATE overrides SET badge=?, note=?, updated_at=? WHERE guid=?').run(String(b.badge || '').trim().slice(0, 24) || null, String(b.note || '').trim().slice(0, 300) || null, now(), g);
  res.redirect(req.get('referer') || '/admin/inventory');
});
A.post('/lead/:id', (req, res) => { db.prepare('UPDATE leads SET handled=? WHERE id=?').run(req.body.handled === '1' ? 1 : 0, parseInt(req.params.id, 10) || 0); res.redirect('/admin/leads'); });
A.get('/leads.csv', (req, res) => {
  const rows = db.prepare('SELECT id,created_at,intent,name,phone,email,vehicle,stock_number,message,preferred_time,source,attribution,crm_status FROM leads ORDER BY id DESC').all();
  const cell = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const cols = rows[0] ? Object.keys(rows[0]) : ['id'];
  res.set('Content-Disposition', 'attachment; filename="ridewithbyron-leads.csv"').type('text/csv').send([cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n'));
});
A.post('/torque/test', async (req, res) => {
  if (!config.torque.webhookUrl) return res.redirect('/admin/leads?m=' + encodeURIComponent('Torque is not configured: set TORQUE_WEBHOOK_URL (and TORQUE_API_KEY / TORQUE_SIGNING_SECRET) on the server, then restart.'));
  const v = { intent: 'question', name: 'TEST — RideWithByron connection check', phone: '256-200-0100', phone_e164: '+12562000100', email: null, message: 'Automated connection test from the RideWithByron admin dashboard. Safe to delete.', preferred_time: null };
  const saved = leads.saveLead(v, { attribution: { utm_source: 'admin-test' }, pageUrl: '/admin' });
  await leads.deliverLead(saved.id);
  const l = db.prepare('SELECT crm_status, crm_last_error FROM leads WHERE id=?').get(saved.id);
  res.redirect('/admin/leads?m=' + encodeURIComponent(l.crm_status === 'delivered' ? 'Test lead delivered to Torque successfully.' : `Torque delivery failed: ${l.crm_last_error || 'unknown error'}`));
});
A.post('/content', (req, res) => {
  const b = req.body;
  const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
  const phoneDigits = String(b.byronPhone || '').replace(/\D/g, '');
  const hero = String(b.heroImage || '').trim();
  setSetting('content', {
    byronPhone: phoneDigits.length >= 10 ? phoneDigits.slice(-10) : '',
    byronEmail: String(b.byronEmail || '').trim().slice(0, 120),
    heroImage: /^https:\/\/[^\s"'<>]+$/.test(hero) ? hero.slice(0, 400) : '',
    showNoFees: b.showNoFees === '1',
    aboutExtra: String(b.aboutExtra || '').trim().slice(0, 2000),
    hours: lines(b.hours).map((l) => l.split('|').map((x) => x.trim())).filter((p) => p.length === 2 && p[0] && p[1]).slice(0, 10).length
      ? lines(b.hours).map((l) => l.split('|').map((x) => x.trim())).filter((p) => p.length === 2 && p[0] && p[1]).slice(0, 10) : DEFAULT_CONTENT.hours,
    testimonials: lines(b.testimonials).map((l) => l.split('|').map((x) => x.trim())).filter((p) => p[0] && p[1]).slice(0, 12).map(([quote, name, detail]) => ({ quote: quote.slice(0, 600), name: name.slice(0, 60), detail: (detail || '').slice(0, 80) })),
  });
  res.redirect('/admin/content?m=' + encodeURIComponent('Content saved.'));
});
app.use('/admin', A);

// ---------------- fallthrough + errors
app.use((req, res) => html(res, pages.notFound(), 404));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).send('Payload too large');
  if (err && (err.type === 'entity.parse.failed' || err.status === 400)) return res.status(400).send('Bad request');
  logError('http', err, `${req.method} ${req.path}`);
  res.status(500).type('html').send('<h1>Something went wrong</h1><p>Please try again, or contact Byron directly.</p>');
});
process.on('unhandledRejection', (e) => logError('unhandledRejection', e));
process.on('uncaughtException', (e) => { logError('uncaughtException', e); });

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`RideWithByron listening on :${config.port} (${config.isProd ? 'production' : 'development'})`);
    sync.startScheduler();
    leads.startOutbox();
  });
}
module.exports = app;
