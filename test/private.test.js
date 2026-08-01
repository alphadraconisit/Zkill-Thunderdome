'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thunderdome-private-'));
process.env.DATA_DIR = TMP;
process.env.SESSION_SECRET = 'test-secret';
process.env.SITE_PASSWORD = 'fleet-only';
process.env.ESI_LOOKUP = '0';

const app = require('../src/server');

let server;
let base;

test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('SITE_PASSWORD hides the whole board', async () => {
  for (const url of ['/', '/kills', '/character/Someone', '/api/killmails']) {
    const res = await fetch(base + url, { redirect: 'manual' });
    assert.equal(res.status, 302, `${url} should redirect to the login page`);
    assert.match(res.headers.get('location'), /^\/login/);
  }
});

test('the login page itself stays reachable', async () => {
  const res = await fetch(`${base}/login`);
  assert.equal(res.status, 200);
});

test('the site password unlocks reading but not the admin area', async () => {
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    body: new URLSearchParams({ password: 'fleet-only', next: '/' }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
  });
  assert.equal(login.status, 302);

  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base, { headers: { cookie } })).status, 200);

  // ADMIN_PASSWORD is unset here, so the admin area reports itself disabled.
  const admin = await fetch(`${base}/admin`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(admin.status, 503);
});

test('the login redirect target cannot be pointed off-site', async () => {
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    body: new URLSearchParams({ password: 'fleet-only', next: '//evil.example.com' }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
  });
  assert.equal(res.headers.get('location'), '/');
});
