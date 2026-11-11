// Sign-in, signed tokens and request helpers. Follows Torque CRM's approach: one admin password
// kept as a Cloudflare secret (ADMIN_PASSWORD); everything signed with HMAC-SHA256 keyed from it.
import { config } from './config.js';

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(data, purpose = 'token') {
  // Until a password is set there is nothing to protect and admin sign-in is refused anyway;
  // public form tokens still need a key, so fall back to a fixed one for that purpose only.
  const secret = config.adminPassword || 'ridewithbyron-unconfigured';
  const key = await crypto.subtle.importKey('raw', enc.encode(`ridewithbyron:${purpose}:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

/** Compare without stopping at the first different character. */
export function same(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function sign(payload, ttlSeconds, purpose) {
  const body = b64url(enc.encode(JSON.stringify({ ...payload, exp: Date.now() + ttlSeconds * 1000 })));
  return `${body}.${await hmac(body, purpose)}`;
}
export async function verify(token, purpose) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!same(sig, await hmac(body, purpose))) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))));
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

export async function passwordOk(password) {
  if (!config.adminPassword) return false;
  // Compare signatures so the comparison takes the same time whatever was typed.
  return same(await hmac(`pw:${password}`, 'login'), await hmac(`pw:${config.adminPassword}`, 'login'));
}

export function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip */ } }
  }
  return out;
}

// ---- admin session (12 hours). Changing ADMIN_PASSWORD signs every device out.
const COOKIE = 'rwb_admin';
const cookieAttrs = () => `Path=/; HttpOnly; SameSite=Strict${config.isProd ? '; Secure' : ''}`;
export async function sessionCookie() {
  const csrf = b64url(crypto.getRandomValues(new Uint8Array(18)));
  return `${COOKIE}=${await sign({ a: 1, csrf }, 12 * 3600, 'session')}; ${cookieAttrs()}; Max-Age=${12 * 3600}`;
}
export const clearCookie = () => `${COOKIE}=; ${cookieAttrs()}; Max-Age=0`;
export async function getSession(request) {
  if (!config.adminPassword) return null;
  const s = await verify(parseCookies(request)[COOKIE], 'session');
  return s && s.a ? s : null;
}

// ---- lead-form token: proves the form was rendered by us and not submitted instantly by a bot
export const formToken = () => sign({ f: 1, t: Date.now() }, 6 * 3600, 'form');
export async function checkFormToken(token) {
  const p = await verify(token, 'form');
  if (!p || !p.f) return 'expired';
  if (Date.now() - p.t < 2500) return 'too-fast';
  return null;
}

/** A daily-rotating, non-reversible visitor key (no cookie, no stored IP address). */
export async function hashIp(ip) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(`${config.adminPassword}|${ip}|${new Date().toISOString().slice(0, 10)}`));
  return b64url(d).slice(0, 16);
}
export const clientIp = (request) => request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '0.0.0.0';
