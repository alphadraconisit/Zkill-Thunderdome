'use strict';

const crypto = require('crypto');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SITE_PASSWORD = process.env.SITE_PASSWORD || '';
const API_KEY = process.env.API_KEY || '';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const COOKIE = 'td_session';
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

if (!process.env.SESSION_SECRET) {
  console.warn('[auth] SESSION_SECRET is not set — sessions will not survive a restart.');
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (!timingSafeEqual(mac, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function issue(res, scopes) {
  res.cookie(COOKIE, sign({ scopes, exp: Date.now() + MAX_AGE_MS }), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE_MS,
  });
}

function clear(res) {
  res.clearCookie(COOKIE);
}

/** Reads the session onto req.session for every request. */
function session(req, res, next) {
  const payload = verify(req.cookies[COOKIE]);
  req.session = payload || { scopes: [] };
  res.locals.isAdmin = req.session.scopes.includes('admin');
  next();
}

/** When SITE_PASSWORD is set, nothing is readable without a login. */
function requireSite(req, res, next) {
  if (!SITE_PASSWORD) return next();
  if (req.session.scopes.includes('site') || req.session.scopes.includes('admin')) return next();
  if (req.path === '/login' || req.path.startsWith('/public/')) return next();
  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).render('message', {
      title: 'Admin disabled',
      message: 'Set ADMIN_PASSWORD in the environment to enable the admin area.',
    });
  }
  if (req.session.scopes.includes('admin')) return next();
  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

/** Bearer-token guard for the write API. */
function requireApiKey(req, res, next) {
  if (!API_KEY) return res.status(503).json({ error: 'Write API disabled: set API_KEY.' });

  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.get('x-api-key') || '';
  if (!token || !timingSafeEqual(token, API_KEY)) {
    return res.status(401).json({ error: 'Invalid or missing API key.' });
  }
  return next();
}

function login(password) {
  if (ADMIN_PASSWORD && timingSafeEqual(password, ADMIN_PASSWORD)) return ['admin', 'site'];
  if (SITE_PASSWORD && timingSafeEqual(password, SITE_PASSWORD)) return ['site'];
  return null;
}

module.exports = {
  session, requireSite, requireAdmin, requireApiKey,
  login, issue, clear,
  ADMIN_PASSWORD, SITE_PASSWORD, API_KEY,
};
