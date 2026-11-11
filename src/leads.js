// Lead capture -> local outbox -> Torque CRM (+ optional instant notification).
// Leads go to Byron only. Nothing here posts to the dealership's general inquiry forms.
import { config } from './config.js';
import { q, now, logError } from './db.js';

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

const INTENTS = {
  quote: 'Get My Best Quote', availability: 'Check Availability', visit: 'Schedule a Visit',
  financing: 'Ask About Financing', question: 'Ask Byron', text: 'Text Byron',
};
const CONSENT_TEXT = 'By submitting, I agree that Byron Green of Shoals Outdoor Sports may contact me by phone, text or email about my inquiry. Message and data rates may apply. Consent is not a condition of purchase. Reply STOP to opt out of texts.';

const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : '');

function normalizePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  const ten = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  if (ten.length !== 10 || /^[01]/.test(ten) || /^(\d)\1{9}$/.test(ten)) return null;
  return '+1' + ten;
}

/** Classify the original traffic source from first-touch attribution captured in the browser. */
function classifySource(a = {}) {
  const src = (a.utm_source || '').toLowerCase();
  const med = (a.utm_medium || '').toLowerCase();
  const ref = (a.referrer || '').toLowerCase();
  const paid = /cpc|ppc|paid|ads?$|display|retarget/.test(med);
  if (/marketplace/.test(src) || /marketplace/.test(med) || /facebook\.com\/marketplace/.test(ref) || /marketplace/.test(a.utm_campaign || '')) return 'Facebook Marketplace';
  if (a.gclid || a.gbraid || a.wbraid || (/google|adwords/.test(src) && paid)) return 'Google Ads';
  if (/instagram|^ig$/.test(src) || /instagram\.com/.test(ref)) return 'Instagram';
  if (a.fbclid && paid) return 'Facebook Ads';
  if (/facebook|^fb$|meta/.test(src)) return paid || a.fbclid ? 'Facebook Ads' : 'Facebook (organic)';
  if (a.fbclid) return 'Facebook Ads';
  if (/facebook\.com|fb\.com/.test(ref)) return 'Facebook (organic)';
  if (/google\./.test(ref) || (src === 'google' && med === 'organic')) return 'Organic Google search';
  if (/bing\.|duckduckgo\.|yahoo\./.test(ref)) return 'Organic search (other)';
  if (src) return `Campaign: ${src}`.slice(0, 60);
  if (ref && !ref.includes(new URL(config.siteUrl).hostname.replace(/^www\./, ''))) return 'Referral';
  return 'Direct';
}

function sanitizeAttribution(raw) {
  let a = raw;
  if (typeof raw === 'string') { try { a = JSON.parse(raw); } catch { a = {}; } }
  if (!a || typeof a !== 'object') a = {};
  const out = {};
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'referrer', 'landing_page', 'first_seen']) {
    if (a[k]) out[k] = clean(String(a[k]), 300);
  }
  return out;
}

function validateLead(body) {
  const errors = {};
  const name = clean(body.name, 80);
  const phoneRaw = clean(body.phone, 30);
  const email = clean(body.email, 120).toLowerCase();
  const intent = INTENTS[body.intent] ? body.intent : 'question';
  if (name.length < 2) errors.name = 'Please enter your name.';
  const phone = normalizePhone(phoneRaw);
  if (!phone) errors.phone = 'Please enter a valid 10-digit phone number.';
  if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) errors.email = 'That email address doesn’t look right.';
  if (body.consent !== 'yes' && body.consent !== 'on') errors.consent = 'Please check the box so Byron can contact you.';
  return {
    errors, ok: Object.keys(errors).length === 0,
    lead: { intent, name, phone: phoneRaw, phone_e164: phone, email: email || null, message: clean(body.message, 1500) || null, preferred_time: clean(body.preferred_time, 80) || null },
  };
}

async function saveLead(lead, ctx) {
  const dedupe = (await sha256(lead.phone_e164 || lead.email || lead.name)).slice(0, 24);
  // Collapse accidental double-submits (same person, same unit, same intent within 10 minutes).
  const recent = await q.get("SELECT id FROM leads WHERE dedupe_key=? AND intent=? AND COALESCE(unit_guid,'')=? AND created_at > ?",
    [dedupe, lead.intent, ctx.unit ? ctx.unit.guid : '', new Date(Date.now() - 600e3).toISOString()]);
  if (recent) return { id: recent.id, duplicate: true };
  const attribution = sanitizeAttribution(ctx.attribution);
  const info = await q.run(`INSERT INTO leads (created_at,intent,name,phone,phone_e164,email,message,preferred_time,unit_guid,vehicle,stock_number,vehicle_url,source,attribution,page_url,consent_text,ip_hash,user_agent,dedupe_key,crm_status)
    VALUES (@created_at,@intent,@name,@phone,@phone_e164,@email,@message,@preferred_time,@unit_guid,@vehicle,@stock_number,@vehicle_url,@source,@attribution,@page_url,@consent_text,@ip_hash,@user_agent,@dedupe_key,@crm_status)`, {
    ...lead, created_at: now(),
    unit_guid: ctx.unit ? ctx.unit.guid : null,
    vehicle: ctx.unit ? ctx.unit.title : (clean(ctx.vehicleText, 120) || null),
    stock_number: ctx.unit ? ctx.unit.stock_number : null,
    vehicle_url: ctx.unit ? config.siteUrl + ctx.unit.url : null,
    source: classifySource(attribution), attribution: JSON.stringify(attribution),
    page_url: clean(ctx.pageUrl, 300) || null, consent_text: CONSENT_TEXT,
    ip_hash: ctx.ipHash || null, user_agent: clean(ctx.userAgent, 200) || null,
    dedupe_key: dedupe, crm_status: config.torque.webhookUrl ? 'pending' : 'not_configured',
  });
  return { id: info.lastId, duplicate: false };
}

/** The payload contract Torque receives. Documented in docs/TORQUE-INTEGRATION.md. */
function torquePayload(l) {
  return {
    event: 'lead.created',
    idempotency_key: `rwb-lead-${l.id}`,
    occurred_at: l.created_at,
    contact: { name: l.name, phone: l.phone_e164, phone_display: l.phone, email: l.email, dedupe_key: l.dedupe_key, match_on: ['phone', 'email'] },
    inquiry: { type: l.intent, label: INTENTS[l.intent] || l.intent, message: l.message, preferred_time: l.preferred_time },
    vehicle: l.vehicle ? { description: l.vehicle, stock_number: l.stock_number, url: l.vehicle_url, source_guid: l.unit_guid, location: 'Shoals Outdoor Sports - Florence' } : null,
    attribution: { source: l.source, ...JSON.parse(l.attribution || '{}') },
    assignment: { assigned_to: config.torque.assignee, notify_immediately: true },
    follow_up_task: { create: true, title: `Follow up: ${l.name} — ${INTENTS[l.intent] || l.intent}${l.vehicle ? ' — ' + l.vehicle : ''}`, due_in_minutes: l.intent === 'visit' ? 60 : 15 },
    consent: { text: l.consent_text, captured_at: l.created_at },
    origin: { site: 'RideWithByron.com', page: l.page_url, lead_id: l.id },
  };
}

async function postJson(url, payload, headers = {}) {
  const body = JSON.stringify(payload);
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'RideWithByron/1.0', ...headers }, body, signal: AbortSignal.timeout(15000) });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  return text;
}

async function deliverLead(id) {
  const l = await q.get('SELECT * FROM leads WHERE id=?', [id]);
  if (!l) return;
  // Instant notification (optional), independent of CRM state
  if (config.notifyWebhookUrl && l.notify_status !== 'sent') {
    try {
      await postJson(config.notifyWebhookUrl, { text: `New ${INTENTS[l.intent] || l.intent} lead: ${l.name} ${l.phone}${l.vehicle ? ' — ' + l.vehicle + ' #' + (l.stock_number || '') : ''} (${l.source})`, lead_id: l.id });
      await q.run("UPDATE leads SET notify_status='sent' WHERE id=?", [id]);
    } catch (e) { await q.run("UPDATE leads SET notify_status='failed' WHERE id=?", [id]); await logError('notify', e); }
  }
  if (!config.torque.webhookUrl || l.crm_status === 'delivered') return;
  const payload = torquePayload(l);
  const raw = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000).toString();
  const headers = { 'Idempotency-Key': payload.idempotency_key, 'X-RWB-Timestamp': ts };
  if (config.torque.apiKey) headers.Authorization = `Bearer ${config.torque.apiKey}`;
  if (config.torque.signingSecret) headers['X-RWB-Signature'] = 'sha256=' + await hmacHex(config.torque.signingSecret, `${ts}.${raw}`);
  try {
    const text = await postJson(config.torque.webhookUrl, payload, headers);
    let ref = null; try { const j = JSON.parse(text); ref = String(j.id || j.contact_id || j.lead_id || '').slice(0, 80) || null; } catch { /* non-JSON ack is fine */ }
    await q.run("UPDATE leads SET crm_status='delivered', crm_delivered_at=?, crm_attempts=crm_attempts+1, crm_last_error=NULL, crm_ref=? WHERE id=?", [now(), ref, id]);
  } catch (e) {
    const attempts = l.crm_attempts + 1;
    const delayMin = Math.min(360, 2 ** attempts); // 2,4,8 … capped at 6h; retried for ~3 days
    await q.run('UPDATE leads SET crm_status=?, crm_attempts=?, crm_last_error=?, crm_next_attempt=? WHERE id=?',
      [attempts >= 20 ? 'failed' : 'pending', attempts, e.message.slice(0, 300), new Date(Date.now() + delayMin * 60000).toISOString(), id]);
    await logError('torque-delivery', e, `lead ${id}`);
  }
}

/** Called from the scheduled trigger: (re)deliver anything still waiting. */
async function runOutbox() {
  if (!config.torque.webhookUrl) return;
  // Leads captured before Torque was configured get delivered once it is.
  await q.run("UPDATE leads SET crm_status='pending' WHERE crm_status='not_configured'");
  const due = await q.all("SELECT id FROM leads WHERE crm_status='pending' AND (crm_next_attempt IS NULL OR crm_next_attempt <= ?) ORDER BY id LIMIT 10", [now()]);
  for (const r of due) await deliverLead(r.id).catch((e) => logError('outbox', e));
}

export { INTENTS, CONSENT_TEXT, validateLead, saveLead, deliverLead, runOutbox, classifySource, sanitizeAttribution, normalizePhone, torquePayload };
