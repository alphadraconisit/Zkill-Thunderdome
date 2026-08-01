'use strict';

const express = require('express');
const auth = require('../auth');

const router = express.Router();

// Small in-memory throttle so the password field is not brute-forceable.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function throttled(ip) {
  const entry = attempts.get(ip);
  if (!entry || Date.now() - entry.first > WINDOW_MS) return false;
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(ip) {
  const entry = attempts.get(ip);
  if (!entry || Date.now() - entry.first > WINDOW_MS) attempts.set(ip, { first: Date.now(), count: 1 });
  else entry.count += 1;
}

function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

router.get('/login', (req, res) => {
  res.render('login', { title: 'Sign in', error: null, next: safeNext(req.query.next) });
});

router.post('/login', (req, res) => {
  const next = safeNext(req.body.next);
  const ip = req.ip || 'unknown';

  if (throttled(ip)) {
    return res.status(429).render('login', {
      title: 'Sign in', next,
      error: 'Too many attempts. Wait a few minutes and try again.',
    });
  }

  const scopes = auth.login(req.body.password || '');
  if (!scopes) {
    recordFailure(ip);
    return res.status(401).render('login', { title: 'Sign in', next, error: 'Wrong password.' });
  }

  attempts.delete(ip);
  auth.issue(res, scopes);
  res.redirect(next);
});

router.post('/logout', (req, res) => {
  auth.clear(res);
  res.redirect('/');
});

module.exports = router;
