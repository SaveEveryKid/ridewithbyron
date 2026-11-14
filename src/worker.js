// RideWithByron.com — the Cloudflare Worker. Static files (public/) are served by Cloudflare;
// every page, form and admin route comes here. A scheduled trigger runs the inventory sync.
//
//   GET  /, /inventory, /inventory/:slug, landing pages, /about, /financing, /contact …
//   POST /lead            lead form (JSON or regular form post)
//   POST /api/event       cookie-less page-view / tap counts
//   /admin/*              password-protected dashboard
//   cron (every 30 min)   inventory sync + lead delivery retries
import { config, initConfig } from './config.js';
import { q, now, useDb, getSetting, setSetting, logError, overLimit } from './db.js';
import * as inv from './inventory.js';
import * as leads from './leads.js';
import * as sec from './security.js';
import { runSync, syncHealth } from './sync/engine.js';
import { runDetails } from './sync/details.js';
import * as pages from './views/pages.js';
import * as admin from './views/admin.js';
import { LANDING, bySlug } from './seo.js';
import { DEFAULT_CONTENT, reqState } from './views/ui.js';
import * as community from './community/store.js';
import { youtubeId } from './community/moderate.js';
import { communityPage, topicPage, communityAdmin } from './views/community.js';
import { COMMUNITY_JS } from './views/community-assets.js';

const CSP = [
  "default-src 'self'", "base-uri 'self'", "object-src 'none'", "frame-ancestors 'none'", "form-action 'self'",
  "script-src 'self' https://www.googletagmanager.com https://connect.facebook.net https://challenges.cloudflare.com",
  // Community ride videos (YouTube's no-cookie player) and the "are you human" check.
  "frame-src https://www.youtube-nocookie.com https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'", "font-src 'self'",
  "img-src 'self' data: https:",
  "connect-src 'self' https://www.google-analytics.com https://*.google-analytics.com https://www.googletagmanager.com https://www.facebook.com https://connect.facebook.net https://*.doubleclick.net https://www.google.com",
].join('; ');

const baseHeaders = (request) => {
  const h = {
    'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  };
  if (config.isProd) h['Strict-Transport-Security'] = 'max-age=15552000; includeSubDomains';
  // Preview addresses must never compete with the real domain in search results.
  if (/\.workers\.dev$/.test(new URL(request.url).hostname)) h['X-Robots-Tag'] = 'noindex, nofollow';
  return h;
};
const html = (request, markup, status = 200, extra = {}) => new Response(markup, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...baseHeaders(request), ...extra } });
const text = (request, body, type = 'text/plain; charset=utf-8', status = 200, extra = {}) => new Response(body, { status, headers: { 'Content-Type': type, ...baseHeaders(request), ...extra } });
const json = (request, body, status = 200) => text(request, JSON.stringify(body), 'application/json', status, { 'Cache-Control': 'no-store' });
const redirect = (request, to, status = 302, extra = {}) => new Response(null, { status, headers: { Location: to, ...baseHeaders(request), ...extra } });

const BOT = /bot|crawl|spider|slurp|preview|monitor|headless|lighthouse|curl|wget|python|scrapy|facebookexternalhit/i;

/** Read a small JSON or form body. Anything large or malformed is rejected. */
async function readBody(request) {
  const raw = await request.text();
  if (raw.length > 20000) throw Object.assign(new Error('Payload too large'), { status: 413 });
  const type = request.headers.get('Content-Type') || '';
  if (type.includes('application/json') || type.includes('text/plain')) {
    try { const b = JSON.parse(raw || '{}'); return b && typeof b === 'object' && !Array.isArray(b) ? b : {}; } catch { throw Object.assign(new Error('Bad request'), { status: 400 }); }
  }
  const out = {};
  for (const [k, v] of new URLSearchParams(raw)) if (!(k in out)) out[k] = v;
  return out;
}
const query = (url) => { const o = {}; for (const [k, v] of url.searchParams) if (!(k in o)) o[k] = v; return o; };

// ---------------- public
async function publicRoutes(request, url, ctx, env = {}) {
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : '/';
  const method = request.method;
  const get = method === 'GET' || method === 'HEAD';

  if (get && path === '/') return html(request, await pages.home());
  if (get && path === '/inventory') return html(request, await pages.inventory(query(url)));
  if (get && path.startsWith('/inventory/')) {
    const u = await inv.getBySlug(decodeURIComponent(path.slice('/inventory/'.length)).slice(0, 160));
    if (u && await inv.isPublic(u)) return html(request, await pages.unitPage(u));
    if (u) {
      // Sold / removed / hidden: send visitors (and ad clicks) to the closest live category instead of a dead end.
      const p = new URLSearchParams();
      if (u.make) p.set('make', u.make);
      if (u.family) p.set('family', u.family); else if (u.vtype) p.set('type', u.vtype);
      return redirect(request, '/inventory?' + p.toString(), u.status === 'active' ? 302 : 301);
    }
    return html(request, pages.notFound(), 404);
  }
  if (get && path === '/about') return html(request, pages.about());
  if (get && path === '/financing') return html(request, pages.financing());
  if (get && path === '/privacy') return html(request, pages.privacy());
  if (get && path === '/about-this-site') return html(request, pages.aboutSite());
  if (get && path === '/contact') {
    const g = url.searchParams.get('unit');
    const unit = g && /^[0-9a-f-]{36}$/.test(g) ? await inv.getByGuid(g) : null;
    const intent = url.searchParams.get('intent');
    return html(request, pages.contact({ intent: leads.INTENTS[intent] ? intent : 'question', unit: unit && await inv.isPublic(unit) ? unit : null }));
  }
  if (get && path === '/visit') return redirect(request, '/contact?intent=visit', 301);
  if (get && bySlug.has(path.slice(1))) return html(request, await pages.landing(bySlug.get(path.slice(1)), query(url)));

  if (get && path === '/robots.txt') return text(request, `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nDisallow: /lead\nDisallow: /contact?\n\nSitemap: ${config.siteUrl}/sitemap.xml\n`);
  if (get && path === '/sitemap.xml') {
    const day = now().slice(0, 10);
    const urls = [['/', day, '1.0'], ['/inventory', day, '0.9'], ...LANDING.map((l) => ['/' + l.slug, day, '0.8']), ['/community', day, '0.6'], ['/about', null, '0.6'], ['/financing', null, '0.5'], ['/contact', null, '0.5'],
      ...(await community.liveTopicIds()).map((t) => [`/community/t/${t.id}`, (t.last_activity || '').slice(0, 10), '0.4']),
      ...(await inv.publicUrls()).map((u) => [`/inventory/${u.slug}`, (u.last_changed || u.last_verified || '').slice(0, 10), '0.7'])];
    return text(request, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(([p, lm, pr]) => `<url><loc>${config.siteUrl}${p}</loc>${lm ? `<lastmod>${lm}</lastmod>` : ''}<priority>${pr}</priority></url>`).join('\n')}\n</urlset>\n`, 'application/xml; charset=utf-8');
  }
  if (get && path === '/favicon.ico') return redirect(request, '/favicon.svg', 301);
  if (get && path === '/healthz') { const h = syncHealth(); return json(request, { ok: true, lastSuccessfulSync: h.lastSuccess, stale: h.stale, paused: h.paused }); }

  // ---- community: ride videos and an open discussion board (no accounts; every post is screened)
  if (path === '/community' || path.startsWith('/community/')) {
    const res = await communityRoutes(request, url, path, env, ctx);
    if (res) return res;
  }

  // ---- first-party, cookie-less counts
  if (method === 'POST' && path === '/api/event') {
    const b = await readBody(request).catch(() => null);
    const ip = await sec.hashIp(sec.clientIp(request));
    if (b && !BOT.test(request.headers.get('User-Agent') || '') && ['view', 'call', 'text', 'lead_open'].includes(b.type) && !(await overLimit('event', ip, 120, 60))) {
      const guid = typeof b.guid === 'string' && /^[0-9a-f-]{36}$/.test(b.guid) ? b.guid : null;
      const source = leads.classifySource(leads.sanitizeAttribution(b.attribution));
      ctx.waitUntil(q.run('INSERT INTO events(at,day,type,path,unit_guid,source,visitor) VALUES(?,?,?,?,?,?,?)', [now(), now().slice(0, 10), b.type, String(b.path || '').slice(0, 200), guid, source, ip]).catch((e) => logError('event', e)));
    }
    return new Response(null, { status: 204, headers: baseHeaders(request) });
  }

  // ---- leads: stored first, then handed to Torque. Never sent to the dealership's general inbox.
  if (method === 'POST' && path === '/lead') {
    const wantsJson = (request.headers.get('Accept') || '').includes('application/json');
    const b = await readBody(request);
    const unit = typeof b.unit === 'string' && /^[0-9a-f-]{36}$/.test(b.unit) ? await inv.getByGuid(b.unit) : null;
    const fail = (status, errors, message) => (wantsJson ? json(request, { ok: false, errors, message }, status)
      : html(request, pages.contact({ intent: b.intent, unit, errors: { ...errors, ...(message ? { consent: message } : {}) }, values: b }), status));
    const ip = await sec.hashIp(sec.clientIp(request));
    if (await overLimit('lead', ip, 8, 900)) return fail(429, {}, 'Too many requests. Please call or text Byron instead.');
    // Spam controls: honeypot, signed render-time token, rate limit. Bots get a quiet success.
    if (b.company) return wantsJson ? json(request, { ok: true }) : html(request, pages.contact({ sent: true }));
    const tokenProblem = await sec.checkFormToken(b._t);
    if (tokenProblem === 'expired') return fail(400, {}, 'This form expired. Please reload the page and try again.');
    if (tokenProblem === 'too-fast') return fail(400, {}, 'Please take a moment to review your details, then send again.');
    const v = leads.validateLead(b);
    if (!v.ok) return fail(422, v.errors);
    try {
      const saved = await leads.saveLead(v.lead, { unit, attribution: b.attribution, pageUrl: b.page_url, ipHash: ip, userAgent: request.headers.get('User-Agent') });
      if (!saved.duplicate) ctx.waitUntil(leads.deliverLead(saved.id).catch((e) => logError('lead-delivery', e)));
      return wantsJson ? json(request, { ok: true }) : html(request, pages.contact({ sent: true, unit }));
    } catch (e) {
      await logError('lead-save', e);
      return fail(500, {}, 'We couldn’t save your message. Please call or text Byron directly.');
    }
  }
  return null;
}

// ---------------- community
const C_COOKIE = 'rwb_c';
const cookieOut = (name, value, days) => `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${days * 86400}; SameSite=Lax${config.isProd ? '; Secure' : ''}${name === C_COOKIE ? '; HttpOnly' : ''}`;

async function humanCheck(request, b) {
  if (!config.turnstile.secret) return true; // not set up: the other checks still apply
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: new URLSearchParams({ secret: config.turnstile.secret, response: String(b['cf-turnstile-response'] || ''), remoteip: sec.clientIp(request) }), signal: AbortSignal.timeout(8000) });
    return !!(await r.json()).success;
  } catch { return false; }
}

async function communityRoutes(request, url, path, env, ctx) {
  const method = request.method;
  const cookies = sec.parseCookies(request);
  const name = String(cookies.rwb_name || '').slice(0, 30);
  const staff = !!(await sec.getSession(request));
  const flash = (url.searchParams.get('m') || '').slice(0, 20);
  const noStore = { 'Cache-Control': 'no-store' };

  if (method === 'GET' || method === 'HEAD') {
    if (path === '/community') {
      const page = parseInt(url.searchParams.get('page'), 10) || 1;
      return html(request, communityPage({ videos: await community.listVideos(), list: await community.listTopics(page), name, flash, staff }));
    }
    if (path === '/community/c.js') return text(request, COMMUNITY_JS, 'text/javascript; charset=utf-8', 200, { 'Cache-Control': 'public, max-age=3600' });
    const m = path.match(/^\/community\/t\/(\d{1,9})$/);
    if (m) {
      const t = await community.getTopic(Number(m[1]));
      return t ? html(request, topicPage({ ...t, name, flash, staff })) : html(request, pages.notFound(), 404);
    }
    return null;
  }
  if (method !== 'POST') return null;
  const b = await readBody(request);
  const ip = sec.clientIp(request);
  const ipHash = await sec.hashIp(ip);
  // Bots: a quiet "thanks" and nothing saved.
  const quiet = () => redirect(request, '/community?m=posted#talk', 303, noStore);
  if (b.company) return quiet();
  const tokenProblem = await sec.checkFormToken(b._t);

  if (path === '/community/report') {
    if (tokenProblem === 'expired' || (await overLimit('creport', ipHash, 10, 3600))) return redirect(request, '/community#talk', 303, noStore);
    const id = parseInt(b.id, 10);
    const token = cookies[C_COOKIE] || community.newToken();
    if (id) await community.reportPost(id, await community.visitorKey(token));
    const back = (request.headers.get('Referer') || '').startsWith(url.origin + '/community') ? new URL(request.headers.get('Referer')).pathname : '/community';
    return redirect(request, `${back}?m=reported`, 303, { ...noStore, 'Set-Cookie': cookieOut(C_COOKIE, token, 365) });
  }

  if (path === '/community/video') {
    const v = { name: String(b.name || '').trim().slice(0, 60), url: String(b.url || '').trim().slice(0, 300), contact: String(b.contact || '').trim().slice(0, 120), note: String(b.note || '').trim().slice(0, 200) };
    const errors = {};
    if (v.name.length < 2) errors.name = 'Please add your name.';
    if (!/^https:\/\/[^\s<>"']{6,}$/.test(v.url)) errors.url = 'Paste the full link, starting with https://';
    if (v.contact.length < 5) errors.contact = 'Add a phone number or email so Byron can reach you.';
    if (b.consent !== 'yes' && b.consent !== 'on') errors.consent = 'Please tick the box.';
    if (tokenProblem) errors.url = errors.url || 'Please take a moment, then send again.';
    if (!Object.keys(errors).length && !(await humanCheck(request, b))) errors.url = 'The “are you human” check didn’t pass. Please try again.';
    if (!Object.keys(errors).length && (await overLimit('cvideo', ipHash, 4, 3600))) errors.url = 'That’s a lot of videos at once. Try again in a bit.';
    if (Object.keys(errors).length) return html(request, communityPage({ videos: await community.listVideos(), list: await community.listTopics(1), name, staff, sendErrors: errors, sendValues: v }), 422);
    await community.addSubmission(v);
    return redirect(request, '/community?m=sent#send', 303, noStore);
  }

  if (path === '/community/post') {
    const parentId = parseInt(b.parent, 10) || null;
    const again = async (errors, status = 422) => {
      const values = { author: b.author, title: b.title, body: b.body };
      if (parentId) {
        const parent = await q.get('SELECT topic_id FROM community_posts WHERE id=?', [parentId]);
        const t = parent ? await community.getTopic(parent.topic_id) : null;
        if (t) return html(request, topicPage({ ...t, name, staff, errors, values }), status);
      }
      return html(request, communityPage({ videos: await community.listVideos(), list: await community.listTopics(1), name, staff, errors, values }), status);
    };
    if (tokenProblem === 'expired') return again({ form: 'This page sat open a while. Please try posting again.' }, 400);
    if (tokenProblem === 'too-fast') return again({ form: 'Give it a second, then post again.' }, 400);
    if (!staff) {
      if (!(await humanCheck(request, b))) return again({ form: 'The “are you human” check didn’t pass. Please try again.' }, 400);
      if (await overLimit('cpost', ipHash, 5, 600) || await overLimit('cpostday', ipHash, 30, 86400)) return again({ form: 'You’re posting a lot. Take a breather and try again in a few minutes.' }, 429);
    }
    const token = cookies[C_COOKIE] || community.newToken();
    const r = await community.createPost({ author: b.author, title: b.title, body: b.body, parentId, visitor: await community.visitorKey(token), ipk: await community.ipKey(ip), staff, ai: env.AI || null });
    if (!r.ok) return again({ [r.field || 'form']: r.message });
    const m = r.status === 'live' ? 'posted' : /link/i.test(r.held) ? 'heldlink' : /first/i.test(r.held) ? 'held' : 'heldreview';
    const res = redirect(request, r.status === 'live' ? `/community/t/${r.topicId}?m=posted#p${r.id}` : `${parentId ? `/community/t/${r.topicId}` : '/community'}?m=${m}`, 303, noStore);
    res.headers.append('Set-Cookie', cookieOut(C_COOKIE, token, 365));
    if (!staff && b.author) res.headers.append('Set-Cookie', cookieOut('rwb_name', String(b.author).trim().slice(0, 30), 365));
    return res;
  }
  return null;
}

// ---------------- admin
async function adminRoutes(request, url, adminEnv = {}) {
  const path = url.pathname.replace(/\/+$/, '') || '/admin';
  const method = request.method;
  const noStore = { 'Cache-Control': 'no-store' };
  const page = (markup, status = 200) => html(request, markup, status, noStore);
  const to = (where, m) => redirect(request, where + (m ? '?m=' + encodeURIComponent(m) : ''), 303, noStore);

  if (path === '/admin/login') {
    if (method === 'GET') return (await sec.getSession(request)) ? to('/admin') : page(admin.login());
    if (method === 'POST') {
      const ip = await sec.hashIp(sec.clientIp(request));
      if (await overLimit('login', ip, 8, 900)) return page(admin.login('Too many sign-in attempts. Try again in 15 minutes.'), 429);
      const b = await readBody(request);
      if (await sec.passwordOk(String(b.password || ''))) return redirect(request, '/admin', 303, { ...noStore, 'Set-Cookie': await sec.sessionCookie() });
      await logError('admin-login', new Error('Failed admin sign-in attempt'), `visitor ${ip}`);
      return page(admin.login(config.adminPassword ? 'Incorrect password.' : ''), 401);
    }
  }
  const session = await sec.getSession(request);
  if (!session) return to('/admin/login');
  const csrf = session.csrf;
  const flash = (url.searchParams.get('m') || '').slice(0, 200);

  if (method === 'GET') {
    if (path === '/admin') return page(await admin.overview(csrf, flash));
    if (path === '/admin/inventory') return page(await admin.inventoryAdmin(csrf, query(url)));
    if (path === '/admin/leads') return page(await admin.leadsAdmin(csrf, query(url), flash));
    if (path === '/admin/traffic') return page(await admin.traffic(csrf));
    if (path === '/admin/content') return page(admin.contentAdmin(csrf, flash));
    if (path === '/admin/logs') return page(await admin.logs(csrf, query(url)));
    if (path === '/admin/community') return page(communityAdmin(csrf, { ...(await community.adminData()), ai: !!adminEnv.AI, turnstile: !!config.turnstile.secret }, flash, admin.shell));
    if (path === '/admin/leads.csv') {
      const rows = await q.all('SELECT id,created_at,intent,name,phone,email,vehicle,stock_number,message,preferred_time,source,attribution,crm_status FROM leads ORDER BY id DESC LIMIT 5000');
      // Prefix cells a spreadsheet would run as a formula.
      const cell = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
      const cols = ['id', 'created_at', 'intent', 'name', 'phone', 'email', 'vehicle', 'stock_number', 'message', 'preferred_time', 'source', 'attribution', 'crm_status'];
      return text(request, [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n'), 'text/csv; charset=utf-8', 200, { ...noStore, 'Content-Disposition': 'attachment; filename="ridewithbyron-leads.csv"' });
    }
    return null;
  }
  if (method !== 'POST') return null;
  const b = await readBody(request);
  if (!sec.same(b._csrf || '', csrf)) return text(request, 'Invalid or missing CSRF token. Go back, reload, and try again.', 'text/plain; charset=utf-8', 403);

  if (path === '/admin/logout') return redirect(request, '/admin/login', 303, { ...noStore, 'Set-Cookie': sec.clearCookie() });
  if (path === '/admin/sync/pause') { await setSetting('sync_paused', true); return to('/admin', 'Synchronization suspended.'); }
  if (path === '/admin/sync/resume') { await setSetting('sync_paused', false); await setSetting('sync_blocked_until', null); return to('/admin', 'Synchronization resumed.'); }
  if (path === '/admin/sync/run') {
    if (getSetting('sync_paused', false)) return to('/admin', 'Synchronization is suspended — resume it first.');
    const r = await runSync({ trigger: 'manual' });
    return to('/admin', `Sync ${r.status}: ${r.message}`.slice(0, 190));
  }
  // ---- community moderation
  let cm = path.match(/^\/admin\/community\/post\/(\d+)$/);
  if (cm) {
    if (['approve', 'remove', 'lock', 'unlock', 'block'].includes(b.action)) await community.moderate(Number(cm[1]), b.action);
    return to('/admin/community', { approve: 'Approved: it is on the page.', remove: 'Removed.', lock: 'Topic closed to new replies.', unlock: 'Topic reopened.', block: 'Removed, and that person can no longer post.' }[b.action] || '');
  }
  if (path === '/admin/community/video') {
    const id = youtubeId(b.url);
    if (!id) return to('/admin/community', 'That doesn’t look like a YouTube link. Paste the link from YouTube’s Share button.');
    await community.addVideo({ youtubeId: id, title: b.title, credit: b.credit });
    return to('/admin/community', 'Video added.');
  }
  cm = path.match(/^\/admin\/community\/video\/(\d+)$/);
  if (cm) { await community.removeVideo(Number(cm[1])); return to('/admin/community', 'Video removed.'); }
  cm = path.match(/^\/admin\/community\/submission\/(\d+)$/);
  if (cm) { await q.run("UPDATE community_submissions SET status=CASE WHEN status='done' THEN 'new' ELSE 'done' END WHERE id=?", [Number(cm[1])]); return to('/admin/community'); }

  let m = path.match(/^\/admin\/unit\/([0-9a-f-]{36})$/);
  if (m) {
    const g = m[1];
    if (!(await q.get('SELECT 1 ok FROM units WHERE guid=?', [g]))) return text(request, 'Unknown unit', undefined, 404);
    const w = [['INSERT OR IGNORE INTO overrides(guid) VALUES(?)', [g]]];
    if (b.featured !== undefined) w.push(['UPDATE overrides SET featured=?, updated_at=? WHERE guid=?', [b.featured === '1' ? 1 : 0, now(), g]]);
    if (b.hidden !== undefined) w.push(['UPDATE overrides SET hidden=?, updated_at=? WHERE guid=?', [b.hidden === '1' ? 1 : 0, now(), g]]);
    if (b.save) w.push(['UPDATE overrides SET badge=?, note=?, updated_at=? WHERE guid=?', [String(b.badge || '').trim().slice(0, 24) || null, String(b.note || '').trim().slice(0, 300) || null, now(), g]]);
    await q.batch(w);
    const back = request.headers.get('Referer') || '';
    return redirect(request, back.startsWith(url.origin + '/admin/inventory') ? back : '/admin/inventory', 303, noStore);
  }
  m = path.match(/^\/admin\/lead\/(\d+)$/);
  if (m) { await q.run('UPDATE leads SET handled=? WHERE id=?', [b.handled === '1' ? 1 : 0, Number(m[1])]); return to('/admin/leads'); }
  if (path === '/admin/torque/test') {
    if (!config.torque.webhookUrl) return to('/admin/leads', 'Torque is not configured: add the TORQUE_WEBHOOK_URL secret (and TORQUE_API_KEY / TORQUE_SIGNING_SECRET) to this Worker.');
    const v = { intent: 'question', name: 'TEST — RideWithByron connection check', phone: '256-200-0100', phone_e164: '+12562000100', email: null, message: `Automated connection test ${now()}. Safe to delete.`, preferred_time: null };
    const saved = await leads.saveLead(v, { attribution: { utm_source: 'admin-test' }, pageUrl: '/admin' });
    await leads.deliverLead(saved.id);
    const l = await q.get('SELECT crm_status, crm_last_error FROM leads WHERE id=?', [saved.id]);
    return to('/admin/leads', l.crm_status === 'delivered' ? 'Test lead delivered to Torque successfully.' : `Torque delivery failed: ${l.crm_last_error || 'unknown error'}`);
  }
  if (path === '/admin/content') {
    const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
    const digits = String(b.byronPhone || '').replace(/\D/g, '');
    const hero = String(b.heroImage || '').trim();
    const hours = lines(b.hours).map((l) => l.split('|').map((x) => x.trim())).filter((p) => p.length === 2 && p[0] && p[1]).slice(0, 10);
    await setSetting('content', {
      byronPhone: digits.length >= 10 ? digits.slice(-10) : '',
      byronEmail: String(b.byronEmail || '').trim().slice(0, 120),
      heroImage: /^https:\/\/[^\s"'<>]+$/.test(hero) ? hero.slice(0, 400) : '',
      showNoFees: b.showNoFees === '1',
      aboutExtra: String(b.aboutExtra || '').trim().slice(0, 2000),
      hours: hours.length ? hours : DEFAULT_CONTENT.hours,
      testimonials: lines(b.testimonials).map((l) => l.split('|').map((x) => x.trim())).filter((p) => p[0] && p[1]).slice(0, 12).map(([quote, name, detail]) => ({ quote: quote.slice(0, 600), name: name.slice(0, 60), detail: (detail || '').slice(0, 80) })),
    });
    return to('/admin/content', 'Content saved.');
  }
  return null;
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  initConfig(env, request.url);
  // One canonical host: the bare domain and www should not both serve the site.
  if (env.SITE_URL) {
    const want = new URL(config.siteUrl);
    const alt = want.hostname.startsWith('www.') ? want.hostname.slice(4) : 'www.' + want.hostname;
    if (url.hostname === alt) return Response.redirect(config.siteUrl + url.pathname + url.search, 301);
  }
  await useDb(env.DB);
  reqState.formToken = await sec.formToken();
  const res = url.pathname === '/admin' || url.pathname.startsWith('/admin/') ? await adminRoutes(request, url, env) : await publicRoutes(request, url, ctx, env);
  return res || html(request, pages.notFound(), 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (err) {
      if (err && err.status) return new Response(err.message, { status: err.status });
      console.error(err);
      try { await logError('http', err, `${request.method} ${new URL(request.url).pathname}`); } catch { /* database itself may be the problem */ }
      const setup = /No database/.test(String(err && err.message));
      return new Response(`<!doctype html><meta charset="utf-8"><title>RideWithByron</title><body style="font-family:system-ui;background:#07080a;color:#f3f5f8;padding:40px"><h1>${setup ? 'Almost there' : 'Something went wrong'}</h1><p>${setup ? 'The site is deployed but has no database yet. Create a D1 database named <b>ridewithbyron</b> in Cloudflare and deploy again.' : 'Please try again, or contact Byron directly.'}</p>`, { status: setup ? 503 : 500, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
  },

  /** Cron trigger (wrangler.jsonc): keep inventory current and retry any undelivered leads. */
  async scheduled(event, env, ctx) {
    initConfig(env);
    await useDb(env.DB);
    try { const r = await runSync({ trigger: 'schedule' }); console.log(`[sync] ${r.status}: ${r.message}`); } catch (e) { await logError('sync-scheduler', e); }
    try { await leads.runOutbox(); } catch (e) { await logError('outbox', e); }
    try { await community.settlePosts(); } catch (e) { await logError('community', e); }
    // Specs and features for models that don't have them yet (a few dealer pages per run).
    try { const d = await runDetails({ max: 4 }); if (d.status !== 'ok' || d.tried) console.log(`[details] ${d.status}: ${d.message || `${d.done}/${d.tried} models`}`); } catch (e) { await logError('details', e); }
  },
};
