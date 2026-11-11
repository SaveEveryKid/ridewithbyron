import { config } from '../config.js';
import { q as dbq, getSetting } from '../db.js';
import { syncHealth } from '../sync/engine.js';
import { INTENTS } from '../leads.js';
import { esc, money, layout, ago, content, logo } from './ui.js';

const TZ = { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' };
const dt = (iso) => (iso ? new Date(iso).toLocaleString('en-US', TZ) + ' CT' : '—');
const pill = (text, kind = '') => `<span class="pill ${kind}">${esc(text)}</span>`;
const STATUS_KIND = { success: 'ok', partial: 'warn', failed: 'bad', blocked: 'bad', running: 'warn', skipped: '' };

function shell(title, active, csrf, body) {
  const tabs = [['/admin', 'Overview'], ['/admin/inventory', 'Inventory'], ['/admin/leads', 'Leads'], ['/admin/traffic', 'Traffic'], ['/admin/content', 'Content'], ['/admin/logs', 'Sync logs']];
  return layout({
    bare: true, noindex: true, title: `${title} · Admin · RideWithByron`, path: '/admin',
    body: `<div class="wrap adm"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><a href="/" style="width:210px;display:block">${logo('a')}</a>
<form method="post" action="/admin/logout"><input type="hidden" name="_csrf" value="${csrf}"><button class="mini">Sign out</button></form></div>
<nav class="adm-nav">${tabs.map(([h, l]) => `<a href="${h}"${h === active ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav>${body}</div>`,
  });
}

function login(error) {
  const ready = !!config.adminPassword;
  return layout({
    bare: true, noindex: true, title: 'Admin sign in · RideWithByron', path: '/admin/login',
    body: `<div class="login"><div style="margin-bottom:20px">${logo('l')}</div><div class="block"><h2>Admin sign in</h2>
${ready ? '' : '<div class="notice bad">No admin password is configured. In Cloudflare, open this Worker → Settings → Variables and Secrets and add a secret named <code>ADMIN_PASSWORD</code>.</div>'}
${error ? `<div class="notice bad">${esc(error)}</div>` : ''}
<form class="form" method="post" action="/admin/login"><label class="f">Password<input type="password" name="password" autocomplete="current-password" required autofocus></label><button class="btn btn-primary btn-block">Sign in</button></form></div></div>`,
  });
}

async function overview(csrf, flash) {
  const h = syncHealth();
  const counts = Object.fromEntries((await dbq.all('SELECT status, COUNT(*) n FROM units GROUP BY status')).map((r) => [r.status, r.n]));
  const hidden = (await dbq.get("SELECT COUNT(*) n FROM overrides o JOIN units u ON u.guid=o.guid WHERE o.hidden=1 AND u.status='active'")).n;
  const staleCut = new Date(Date.now() - config.source.staleAfterMinutes * 60000).toISOString();
  const stale = (await dbq.get("SELECT COUNT(*) n FROM units WHERE status='active' AND last_verified < ?", [staleCut])).n;
  const runs = (await dbq.all('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 8'));
  const quarantined = (await dbq.all("SELECT guid,title,stock_number,status_reason,location_name,source_url,last_checked FROM units WHERE status='quarantined' ORDER BY last_checked DESC LIMIT 50"));
  const since = (d) => new Date(Date.now() - d * 86400e3).toISOString();
  const leadCount = async (d, where = '1=1') => (await dbq.get(`SELECT COUNT(*) n FROM leads WHERE created_at >= ? AND ${where}`, [since(d)])).n;
  const lead = { d1: await leadCount(1), d7: await leadCount(7), quote: await leadCount(30, "intent='quote'"), visit: await leadCount(30, "intent='visit'") };
  const crmPending = (await dbq.all("SELECT crm_status, COUNT(*) n FROM leads GROUP BY crm_status"));
  const errors = (await dbq.all('SELECT * FROM error_log ORDER BY id DESC LIMIT 8'));
  const blockedUntil = getSetting('sync_blocked_until', null);
  const cooling = blockedUntil && new Date(blockedUntil) > new Date();
  const torqueOn = !!config.torque.webhookUrl;
  const delivered = (await dbq.get("SELECT COUNT(*) n FROM leads WHERE crm_status='delivered'")).n;
  return shell('Overview', '/admin', csrf, `
${flash ? `<div class="notice ok">${esc(flash)}</div>` : ''}
${h.paused ? '<div class="notice bad"><b>Inventory synchronization is SUSPENDED.</b> Listings are not being refreshed; they are marked stale after a few hours and hidden after 24 hours.</div>' : ''}
${cooling ? `<div class="notice bad">The dealership site returned an anti-bot challenge. Automatic runs are paused until ${esc(dt(blockedUntil))}. Existing listings are kept and marked for re-verification. If this keeps happening, see docs/INVENTORY-SOURCE.md.</div>` : ''}
<h2 style="margin-top:0">Inventory synchronization</h2>
<div class="stats">
<div class="stat"><b>${counts.active || 0}</b><span>Florence units live${hidden ? ` (${hidden} hidden by you)` : ''}</span></div>
<div class="stat"><b>${h.lastSuccess ? esc(ago(h.lastSuccess)) : 'never'}</b><span>Last successful sync${h.lastSuccess ? '<br>' + esc(dt(h.lastSuccess)) : ''}</span></div>
<div class="stat"><b style="color:${(counts.quarantined || 0) ? 'var(--warn)' : 'inherit'}">${counts.quarantined || 0}</b><span>Quarantined (location unverified)</span></div>
<div class="stat"><b style="color:${stale ? 'var(--warn)' : 'inherit'}">${stale}</b><span>Live units awaiting re-verification</span></div>
<div class="stat"><b>${counts.other_location || 0}</b><span>Excluded: other locations</span></div>
<div class="stat"><b>${counts.catalog || 0}</b><span>Excluded: catalog (not in stock)</span></div>
<div class="stat"><b>${runs[0] && runs[0].source_count != null ? runs[0].source_count : '—'}</b><span>Records read on last sync</span></div>
<div class="stat"><b>${(counts.unavailable || 0) + (counts.removed || 0)}</b><span>Sold / removed (hidden)</span></div>

</div>
<div class="inline" style="margin-top:14px">
<form method="post" action="/admin/sync/run"><input type="hidden" name="_csrf" value="${csrf}"><button class="btn btn-primary btn-sm"${h.running ? ' disabled' : ''}>${h.running ? 'Sync running…' : 'Run sync now'}</button></form>
<form method="post" action="/admin/sync/${h.paused ? 'resume' : 'pause'}"><input type="hidden" name="_csrf" value="${csrf}"><button class="btn btn-sm ${h.paused ? 'btn-white' : 'btn-ghost'}" style="${h.paused ? '' : 'border-color:var(--bad);color:var(--bad)'}">${h.paused ? 'Resume synchronization' : 'Suspend synchronization'}</button></form>
<span class="muted small">Source: ${esc(config.source.baseUrl)} · every ${config.source.intervalMinutes} min · Florence id ${esc(config.source.florenceDealershipId.slice(0, 8))}…</span></div>
<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Started</th><th>Trigger</th><th>Status</th><th>Records</th><th>New</th><th>Updated</th><th>Price Δ</th><th>Removed</th><th>Quar.</th><th>Errors</th><th>Message</th></tr></thead><tbody>
${runs.map((r) => `<tr><td>${esc(dt(r.started_at))}</td><td>${esc(r.trigger)}</td><td>${pill(r.status, STATUS_KIND[r.status])}</td><td>${r.source_count ?? '—'}</td><td>${r.added}</td><td>${r.updated}</td><td>${r.price_changes}</td><td>${r.removed}</td><td>${r.quarantined}</td><td>${r.errors}</td><td>${esc(r.message || '')}</td></tr>`).join('') || '<tr><td colspan="11">No runs yet.</td></tr>'}</tbody></table></div>

<h2>Inventory errors &amp; quarantine</h2>
${quarantined.length ? `<p class="muted small">These units were found but their Florence location could not be verified, so they are not shown publicly.</p><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Unit</th><th>Stock</th><th>Source location</th><th>Reason</th><th>Checked</th></tr></thead><tbody>${quarantined.map((q) => `<tr><td><a href="${esc(q.source_url)}" target="_blank" rel="noopener noreferrer">${esc(q.title || q.guid)}</a></td><td>${esc(q.stock_number || '')}</td><td>${esc(q.location_name || '—')}</td><td>${esc(q.status_reason)}</td><td>${esc(ago(q.last_checked))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nothing in quarantine.</p>'}

<h2>Leads</h2>
<div class="stats"><div class="stat"><b>${lead.d1}</b><span>Last 24 hours</span></div><div class="stat"><b>${lead.d7}</b><span>Last 7 days</span></div><div class="stat"><b>${lead.quote}</b><span>Quote requests (30 days)</span></div><div class="stat"><b>${lead.visit}</b><span>Visit requests (30 days)</span></div></div>
<div class="notice ${torqueOn ? (delivered ? 'ok' : 'info') : ''}"><b>Torque CRM:</b> ${torqueOn ? (delivered ? `connected — ${delivered} lead(s) delivered.` : 'webhook configured but no delivery has succeeded yet. Use “Send test lead to Torque” on the Leads tab.') : 'NOT CONNECTED. Leads are stored safely here and will be delivered automatically once the TORQUE_WEBHOOK_URL secret is set.'} ${crmPending.map((c) => `${pill(c.crm_status + ': ' + c.n, c.crm_status === 'delivered' ? 'ok' : c.crm_status === 'failed' ? 'bad' : 'warn')}`).join(' ')}</div>

<h2>Recent errors</h2>
${errors.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Area</th><th>Message</th></tr></thead><tbody>${errors.map((e) => `<tr><td>${esc(dt(e.at))}</td><td>${esc(e.scope)}</td><td>${esc(e.message)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No errors logged.</p>'}`);
}

async function inventoryAdmin(csrf, q) {
  const status = ['active', 'quarantined', 'unavailable', 'removed', 'other_location'].includes(q.status) ? q.status : 'active';
  const term = typeof q.q === 'string' ? q.q.slice(0, 60) : '';
  const rows = (await dbq.all(`SELECT u.guid,u.title,u.stock_number,u.price,u.msrp,u.slug,u.location_name,u.status_reason,u.last_verified,u.last_checked,u.source_url,COALESCE(o.featured,0) featured,COALESCE(o.hidden,0) hidden,o.badge,o.note
    FROM units u LEFT JOIN overrides o ON o.guid=u.guid WHERE u.status=? AND (?='' OR lower(u.title||' '||COALESCE(u.stock_number,'')) LIKE ?) ORDER BY featured DESC, u.title LIMIT 400`, [status, term, `%${term.toLowerCase()}%`]));
  return shell('Inventory', '/admin/inventory', csrf, `
<h2 style="margin-top:0">Synced inventory</h2>
<p class="muted small">Feature, hide, badge or annotate units. These settings are stored separately and never change the synced dealership data. Hidden units stay hidden even when the sync updates them.</p>
<form class="inline" method="get"><select name="status" style="width:auto;min-height:40px">${['active', 'quarantined', 'unavailable', 'removed', 'other_location'].map((s) => `<option${s === status ? ' selected' : ''}>${s}</option>`).join('')}</select><input type="text" name="q" value="${esc(term)}" placeholder="Search title / stock" style="width:200px;min-height:40px"><button class="mini" style="min-height:40px">Filter</button><span class="muted small">${rows.length} shown</span></form>
<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Unit</th><th>Stock</th><th>Price</th><th>Source location</th><th>Verified</th><th>Presentation</th></tr></thead><tbody>
${rows.map((u) => `<tr><td>${u.slug && status === 'active' ? `<a href="/inventory/${esc(u.slug)}" target="_blank">${esc(u.title)}</a>` : esc(u.title || u.guid)}<br><a class="small muted" href="${esc(u.source_url)}" target="_blank" rel="noopener noreferrer">dealership listing ↗</a></td><td>${esc(u.stock_number || '')}</td><td>${u.price != null ? money(u.price) : '<span class="muted">not published</span>'}</td><td>${esc(u.location_name || '—')}${status !== 'active' ? `<br><span class="small muted">${esc(u.status_reason || '')}</span>` : ''}</td><td>${esc(ago(u.last_verified))}</td>
<td>${status === 'active' ? `<form class="inline" method="post" action="/admin/unit/${u.guid}"><input type="hidden" name="_csrf" value="${csrf}">
<button class="mini ${u.featured ? 'on' : ''}" name="featured" value="${u.featured ? 0 : 1}">${u.featured ? '★ Featured' : '☆ Feature'}</button>
<button class="mini ${u.hidden ? 'danger' : ''}" name="hidden" value="${u.hidden ? 0 : 1}">${u.hidden ? 'Hidden — show' : 'Hide'}</button></form>
<form class="inline" method="post" action="/admin/unit/${u.guid}" style="margin-top:6px"><input type="hidden" name="_csrf" value="${csrf}"><input type="text" name="badge" maxlength="24" placeholder="Badge" value="${esc(u.badge || '')}"><input type="text" name="note" maxlength="300" placeholder="Byron’s note" value="${esc(u.note || '')}" style="width:190px"><button class="mini" name="save" value="1">Save</button></form>` : '<span class="muted small">not public</span>'}</td></tr>`).join('') || '<tr><td colspan="6">No units with this status.</td></tr>'}</tbody></table></div>`);
}

async function leadsAdmin(csrf, q, flash) {
  const intent = INTENTS[q.intent] ? q.intent : '';
  const rows = (await dbq.all(`SELECT * FROM leads WHERE (?='' OR intent=?) ORDER BY id DESC LIMIT 300`, [intent, intent]));
  return shell('Leads', '/admin/leads', csrf, `
${flash ? `<div class="notice info">${esc(flash)}</div>` : ''}
<h2 style="margin-top:0">Incoming leads</h2>
<div class="inline"><form class="inline" method="get"><select name="intent" style="width:auto;min-height:40px"><option value="">All types</option>${Object.entries(INTENTS).map(([k, v]) => `<option value="${k}"${k === intent ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select><button class="mini" style="min-height:40px">Filter</button></form>
<a class="mini" style="display:inline-grid;place-items:center;min-height:40px" href="/admin/leads?intent=quote">Quote requests</a><a class="mini" style="display:inline-grid;place-items:center;min-height:40px" href="/admin/leads?intent=visit">Appointments</a>
<a class="mini" style="display:inline-grid;place-items:center;min-height:40px" href="/admin/leads.csv">Export CSV</a>
<form method="post" action="/admin/torque/test"><input type="hidden" name="_csrf" value="${csrf}"><button class="mini" style="min-height:40px">Send test lead to Torque</button></form></div>
<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Received</th><th>Type</th><th>Customer</th><th>Vehicle</th><th>Message</th><th>Source</th><th>Torque</th><th></th></tr></thead><tbody>
${rows.map((l) => `<tr style="${l.handled ? 'opacity:.55' : ''}"><td>${esc(dt(l.created_at))}</td><td>${esc(INTENTS[l.intent] || l.intent)}${l.preferred_time ? `<br><span class="small muted">Wants: ${esc(l.preferred_time)}</span>` : ''}</td>
<td><b>${esc(l.name)}</b><br><a href="tel:${esc(l.phone_e164)}">${esc(l.phone)}</a>${l.email ? `<br><a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : ''}</td>
<td>${l.vehicle ? `${esc(l.vehicle)}<br><span class="small muted">Stock #${esc(l.stock_number || '—')}</span>` : '<span class="muted">General</span>'}</td><td style="max-width:260px">${esc(l.message || '')}</td>
<td>${esc(l.source || '')}${(() => { try { const a = JSON.parse(l.attribution || '{}'); return a.utm_campaign ? `<br><span class="small muted">${esc(a.utm_campaign)}</span>` : ''; } catch (e) { return ''; } })()}</td>
<td>${pill(l.crm_status.replace('_', ' '), l.crm_status === 'delivered' ? 'ok' : l.crm_status === 'failed' ? 'bad' : 'warn')}${l.crm_last_error ? `<br><span class="small muted">${esc(l.crm_last_error.slice(0, 60))}</span>` : ''}</td>
<td><form method="post" action="/admin/lead/${l.id}"><input type="hidden" name="_csrf" value="${csrf}"><button class="mini" name="handled" value="${l.handled ? 0 : 1}">${l.handled ? 'Reopen' : 'Done'}</button></form></td></tr>`).join('') || '<tr><td colspan="8">No leads yet.</td></tr>'}</tbody></table></div>`);
}

async function traffic(csrf) {
  const since = new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10);
  const sources = (await dbq.all("SELECT source, COUNT(DISTINCT visitor||day) visits, COUNT(*) views FROM events WHERE type='view' AND day>=? GROUP BY source ORDER BY visits DESC", [since]));
  const leadSrc = Object.fromEntries((await dbq.all('SELECT source, COUNT(*) n FROM leads WHERE created_at>=? GROUP BY source', [since])).map((r) => [r.source, r.n]));
  const top = (await dbq.all(`SELECT e.unit_guid, u.title, u.stock_number, u.slug, u.status, COUNT(*) views, COUNT(DISTINCT e.visitor||e.day) visitors,
    (SELECT COUNT(*) FROM leads l WHERE l.unit_guid=e.unit_guid AND l.created_at>=?) leads,
    (SELECT COUNT(*) FROM events c WHERE c.unit_guid=e.unit_guid AND c.type IN ('call','text') AND c.day>=?) taps
    FROM events e LEFT JOIN units u ON u.guid=e.unit_guid WHERE e.type='view' AND e.unit_guid IS NOT NULL AND e.day>=? GROUP BY e.unit_guid ORDER BY views DESC LIMIT 25`, [since, since, since]));
  const days = (await dbq.all("SELECT day, COUNT(DISTINCT visitor) visitors, COUNT(*) views FROM events WHERE type='view' AND day>=? GROUP BY day ORDER BY day DESC LIMIT 14", [since]));
  const taps = (await dbq.all("SELECT type, COUNT(*) n FROM events WHERE type IN ('call','text','lead_open') AND day>=? GROUP BY type", [since]));
  const allSrc = [...new Set([...sources.map((s) => s.source), ...Object.keys(leadSrc)])];
  return shell('Traffic', '/admin/traffic', csrf, `
<h2 style="margin-top:0">Traffic sources — last 30 days</h2><p class="muted small">First-party counts (no cookies). Visits are unique visitors per day; bots are filtered by user-agent.</p>
<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Source</th><th>Visits</th><th>Page views</th><th>Leads</th><th>Lead rate</th></tr></thead><tbody>${allSrc.map((s) => { const r = sources.find((x) => x.source === s) || { visits: 0, views: 0 }; const n = leadSrc[s] || 0; return `<tr><td>${esc(s || 'Direct')}</td><td>${r.visits}</td><td>${r.views}</td><td>${n}</td><td>${r.visits ? (100 * n / r.visits).toFixed(1) + '%' : '—'}</td></tr>`; }).join('') || '<tr><td colspan="5">No traffic recorded yet.</td></tr>'}</tbody></table></div>
<div class="stats" style="margin-top:14px">${['call', 'text', 'lead_open'].map((t) => `<div class="stat"><b>${(taps.find((x) => x.type === t) || { n: 0 }).n}</b><span>${{ call: 'Tap-to-call', text: 'Tap-to-text', lead_open: 'Lead form opens' }[t]}</span></div>`).join('')}</div>
<h2>Best-performing vehicle pages</h2>
<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Vehicle</th><th>Stock</th><th>Views</th><th>Visitors</th><th>Call/text taps</th><th>Leads</th><th>Status</th></tr></thead><tbody>${top.map((t) => `<tr><td>${t.slug ? `<a href="/inventory/${esc(t.slug)}">${esc(t.title)}</a>` : esc(t.title || t.unit_guid)}</td><td>${esc(t.stock_number || '')}</td><td>${t.views}</td><td>${t.visitors}</td><td>${t.taps}</td><td>${t.leads}</td><td>${esc(t.status || '')}</td></tr>`).join('') || '<tr><td colspan="7">No vehicle page views yet.</td></tr>'}</tbody></table></div>
<h2>Daily</h2><div class="tbl-wrap"><table class="tbl" style="min-width:300px"><thead><tr><th>Day</th><th>Visitors</th><th>Page views</th></tr></thead><tbody>${days.map((d) => `<tr><td>${d.day}</td><td>${d.visitors}</td><td>${d.views}</td></tr>`).join('') || '<tr><td colspan="3">—</td></tr>'}</tbody></table></div>`);
}

function contentAdmin(csrf, flash) {
  const c = content();
  return shell('Content', '/admin/content', csrf, `
${flash ? `<div class="notice ok">${esc(flash)}</div>` : ''}
<h2 style="margin-top:0">Website content</h2>
<form class="form" method="post" action="/admin/content" style="max-width:720px"><input type="hidden" name="_csrf" value="${csrf}">
<label class="f">Byron’s direct phone (enables one-tap Call / Text buttons)<input name="byronPhone" value="${esc(c.byronPhone)}" placeholder="256-555-0123" inputmode="tel"></label>
<label class="f">Byron’s email (optional, not displayed publicly)<input name="byronEmail" type="email" value="${esc(c.byronEmail)}"></label>
<label class="f">Hero photo URL (optional — use only photography you have rights to)<input name="heroImage" value="${esc(c.heroImage)}" placeholder="https://…"></label>
<label class="check" style="font-size:.92rem;color:var(--text)"><input type="checkbox" name="showNoFees" value="1"${c.showNoFees ? ' checked' : ''}><span>Show “no dealer fees” messaging. Keep this on only while it matches current Shoals Outdoor Sports policy.</span></label>
<label class="f">Extra “About Byron” paragraph (optional)<textarea name="aboutExtra" maxlength="2000">${esc(c.aboutExtra)}</textarea></label>
<label class="f">Dealership hours — one per line as “Days | Hours”<textarea name="hours">${esc(c.hours.map((h) => h.join(' | ')).join('\n'))}</textarea></label>
<label class="f">Customer testimonials — genuine, approved reviews only. One per line as “Quote | Name | Detail”. Leave empty to hide the section.<textarea name="testimonials" style="min-height:140px">${esc((c.testimonials || []).map((t) => [t.quote, t.name, t.detail || ''].join(' | ')).join('\n'))}</textarea></label>
<button class="btn btn-primary">Save content</button></form>`);
}

async function logs(csrf, q) {
  const runId = parseInt(q.run, 10) || ((await dbq.get('SELECT MAX(id) id FROM sync_runs')).id || 0);
  const runs = (await dbq.all('SELECT id, started_at, status FROM sync_runs ORDER BY id DESC LIMIT 40'));
  const rows = (await dbq.all('SELECT * FROM sync_log WHERE run_id=? ORDER BY id DESC LIMIT 600', [runId]));
  return shell('Sync logs', '/admin/logs', csrf, `<h2 style="margin-top:0">Synchronization log</h2>
<form class="inline" method="get"><select name="run" style="width:auto;min-height:40px">${runs.map((r) => `<option value="${r.id}"${r.id === runId ? ' selected' : ''}>#${r.id} · ${esc(dt(r.started_at))} · ${r.status}</option>`).join('')}</select><button class="mini" style="min-height:40px">View</button></form>
<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Time</th><th>Level</th><th>Unit</th><th>Message</th></tr></thead><tbody>${rows.map((r) => `<tr><td style="white-space:nowrap">${esc(dt(r.at))}</td><td>${pill(r.level, r.level === 'error' ? 'bad' : r.level === 'warn' ? 'warn' : '')}</td><td class="small muted">${esc((r.guid || '').slice(0, 8))}</td><td>${esc(r.message)}</td></tr>`).join('') || '<tr><td colspan="4">No log entries.</td></tr>'}</tbody></table></div>`);
}

export { login, overview, inventoryAdmin, leadsAdmin, traffic, contentAdmin, logs };
