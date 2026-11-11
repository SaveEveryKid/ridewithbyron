'use strict';
const crypto = require('crypto');
const config = require('./config');

const hmac = (data) => crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url');
const safeEq = (a, b) => {
  const A = Buffer.from(String(a)); const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};

// ---- signed tokens (admin session, form anti-spam token)
function sign(payload, ttlSeconds) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlSeconds * 1000 })).toString('base64url');
  return `${body}.${hmac(body)}`;
}
function verify(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!safeEq(sig, hmac(body))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch (e) { return null; }
}

// ---- passwords (scrypt). Stored format: scrypt$<salt>$<hash>
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('base64url');
  return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 64).toString('base64url')}`;
}
function checkPassword(pw, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  return safeEq(crypto.scryptSync(String(pw), salt, 64).toString('base64url'), hash);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---- admin session
const COOKIE = 'rwb_admin';
function setSession(res) {
  const csrf = crypto.randomBytes(18).toString('base64url');
  res.cookie(COOKIE, sign({ a: 1, csrf }, 12 * 3600), { httpOnly: true, sameSite: 'strict', secure: config.isProd, maxAge: 12 * 3600e3, path: '/' });
}
const getSession = (req) => verify(parseCookies(req)[COOKIE]);
function requireAdmin(req, res, next) {
  const s = getSession(req);
  if (!s || !s.a) return res.redirect('/admin/login');
  req.admin = s;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (!safeEq(req.body && req.body._csrf, s.csrf)) return res.status(403).send('Invalid or missing CSRF token. Go back, reload, and try again.');
  }
  res.set('Cache-Control', 'no-store');
  next();
}
const clearSession = (res) => res.clearCookie(COOKIE, { path: '/' });

// ---- lead-form token: proves the form was rendered by us and not submitted instantly by a bot
const formToken = () => sign({ f: 1, t: Date.now() }, 6 * 3600);
function checkFormToken(token) {
  const p = verify(token);
  if (!p || !p.f) return 'expired';
  if (Date.now() - p.t < 2500) return 'too-fast';
  return null;
}

const hashIp = (ip) => crypto.createHash('sha256').update(`${config.sessionSecret}|${ip}|${new Date().toISOString().slice(0, 10)}`).digest('hex').slice(0, 16);

module.exports = { sign, verify, hashPassword, checkPassword, parseCookies, setSession, getSession, requireAdmin, clearSession, formToken, checkFormToken, hashIp, hmac, safeEq };
