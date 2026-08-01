'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Must be set before the app (and therefore the database) is required.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thunderdome-test-'));
process.env.TURSO_DATABASE_URL = `file:${path.join(TMP, 'test.db')}`;
process.env.SESSION_SECRET = 'test-secret';
process.env.API_KEY = 'test-api-key';
process.env.ADMIN_PASSWORD = 'test-admin';
process.env.ESI_LOOKUP = '0';
process.env.BOARD_NAME = 'Testdome';

const app = require('../src/server');

const SAMPLE = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-killmail.txt'), 'utf8');

let server;
let base;

test.before(async () => {
  await app.init();
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function post(pathname, body, headers = {}) {
  return fetch(`${base}${pathname}`, { method: 'POST', body, headers, redirect: 'manual' });
}

test('the write API rejects requests without a key', async () => {
  const res = await post('/api/killmails', SAMPLE, { 'Content-Type': 'text/plain' });
  assert.equal(res.status, 401);
});

test('the write API accepts a pasted killmail', async () => {
  const res = await post('/api/killmails', SAMPLE, {
    'Content-Type': 'text/plain',
    Authorization: 'Bearer test-api-key',
  });
  assert.equal(res.status, 201);

  const body = await res.json();
  assert.equal(body.created.length, 1);
  assert.equal(body.created[0].victim, 'DraconisBeta');
  assert.equal(body.errors.length, 0);
});

test('re-posting the same killmail is a no-op', async () => {
  const res = await post('/api/killmails', SAMPLE, {
    'Content-Type': 'text/plain',
    Authorization: 'Bearer test-api-key',
  });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.created.length, 0);
  assert.equal(body.duplicates, 1);
});

test('malformed input reports an error instead of crashing', async () => {
  const res = await post('/api/killmails', 'not a killmail at all', {
    'Content-Type': 'text/plain',
    Authorization: 'Bearer test-api-key',
  });
  assert.equal(res.status, 400);
  assert.ok((await res.json()).errors.length > 0);
});

test('the home page lists the killmail', async () => {
  const html = await (await fetch(base)).text();
  assert.match(html, /DraconisBeta/);
  assert.match(html, /Crane/);
  assert.match(html, /Ahbazon/);
});

test('leaderboards fall back to all time when the last 30 days were quiet', async () => {
  const html = await (await fetch(base)).text();
  // The fixture killmail is dated 2026-06-27, so on any later run the 30-day
  // window is empty and the panels must still show something.
  const stale = new Date('2026-06-27T15:33:15Z').getTime() < Date.now() - 30 * 86400000;
  if (stale) {
    assert.match(html, /Top pilots \(all time\)/i);
    assert.match(html, /EF Zeta/);
  } else {
    assert.match(html, /Top pilots \(30d\)/i);
  }
});

test('the kill detail page renders victim, attackers and items', async () => {
  const list = await (await fetch(`${base}/api/killmails`)).json();
  const id = list.killmails[0].id;

  const html = await (await fetch(`${base}/kill/${id}`)).text();
  assert.match(html, /DraconisBeta/);
  assert.match(html, /EF Zeta/);
  assert.match(html, /final blow/);
  assert.match(html, /Imperial Navy Large EMP Smartbomb/);
  assert.match(html, /Nanite Repair Paste/);
  assert.match(html, /Oxygen Isotopes/);
});

test('the JSON detail endpoint mirrors the page', async () => {
  const list = await (await fetch(`${base}/api/killmails`)).json();
  const kill = await (await fetch(`${base}/api/killmails/${list.killmails[0].id}`)).json();

  assert.equal(kill.victim.name, 'DraconisBeta');
  assert.equal(kill.involved.length, 5);
  assert.equal(kill.involved[0].name, 'EF Zeta');
  assert.equal(kill.destroyed_items.length, 30);
  assert.equal(kill.dropped_items.length, 22);
  assert.equal(kill.final_blow, 'EF Delta');
});

test('entity pages split kills from losses', async () => {
  const victim = await (await fetch(`${base}/character/DraconisBeta?side=losses`)).text();
  assert.match(victim, /Crane/);

  const attacker = await (await fetch(`${base}/character/EF%20Zeta?side=kills`)).text();
  assert.match(attacker, /Crane/);

  const attackerLosses = await (await fetch(`${base}/character/EF%20Zeta?side=losses`)).text();
  assert.match(attackerLosses, /No killmails match this view/);
});

test('corporation, alliance, system and ship pages resolve', async () => {
  for (const url of [
    '/corporation/Endless-Fury',
    '/alliance/Ahbazon-Prime',
    '/system/Ahbazon',
    '/ship/Crane',
  ]) {
    const res = await fetch(base + url);
    assert.equal(res.status, 200, `${url} should render`);
    assert.match(await res.text(), /Crane/);
  }
});

test('search jumps straight to an exact match', async () => {
  const res = await fetch(`${base}/search?q=Ahbazon`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/system/Ahbazon');
});

test('search lists partial matches', async () => {
  const html = await (await fetch(`${base}/search?q=EF`)).text();
  assert.match(html, /EF Zeta/);
  assert.match(html, /EF Delta/);
});

test('the admin area requires a login', async () => {
  const res = await fetch(`${base}/admin`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/login/);
});

test('signing in as admin unlocks submission', async () => {
  const login = await post('/login', new URLSearchParams({ password: 'test-admin', next: '/admin' }), {
    'Content-Type': 'application/x-www-form-urlencoded',
  });
  assert.equal(login.status, 302);

  const cookie = login.headers.get('set-cookie').split(';')[0];
  const res = await fetch(`${base}/admin`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Submit killmail/);
});

test('a wrong password does not sign in', async () => {
  const res = await post('/login', new URLSearchParams({ password: 'nope' }), {
    'Content-Type': 'application/x-www-form-urlencoded',
  });
  assert.equal(res.status, 401);
});

test('the raw killmail is served back verbatim', async () => {
  const list = await (await fetch(`${base}/api/killmails`)).json();
  const raw = await (await fetch(`${base}/kill/${list.killmails[0].id}/raw`)).text();
  assert.match(raw, /^2026\.06\.27 15:33:15/);
  assert.match(raw, /Dropped items:/);
});

test('a battle report aggregates the window into sides', async () => {
  const html = await (await fetch(
    `${base}/battle/report?from=2026-06-27T15:00&to=2026-06-27T16:00`
  )).text();

  assert.match(html, /Damage timeline/);
  assert.match(html, /Ahbazon-Prime/, 'the attacking alliance is a side');
  assert.match(html, /OnlyAlts\./, 'the victim alliance is a side');
  assert.match(html, /EF Zeta/);
  assert.match(html, /2\.8k/, 'per-pilot damage is listed, compactly');
  assert.match(html, /recvd/, 'damage received is listed alongside');
  assert.doesNotMatch(html, /ISK/, 'battle reports carry no ISK figures');
});

test('a battle report with no killmails in range says so', async () => {
  const html = await (await fetch(
    `${base}/battle/report?from=2020-01-01T00:00&to=2020-01-02T00:00`
  )).text();
  assert.match(html, /No killmails between/);
});

test('the battle window accepts presets', async () => {
  const res = await fetch(`${base}/battle/report?preset=30d`);
  assert.equal(res.status, 200);
});

test('the battles tab lists detected battles', async () => {
  const res = await fetch(`${base}/battle?scan=90d&min=1`);
  assert.equal(res.status, 200);

  const html = await res.text();
  assert.match(html, /Detected battles/);
  // The fixture is a single killmail, so it only shows with a minimum of 1.
  assert.match(html, /Ahbazon/);
  assert.match(html, /href="\/battle\/report\?[^"]+"/, 'each battle links to its report');
});

test('the battles tab hides lone killmails by default', async () => {
  const html = await (await fetch(`${base}/battle?scan=90d`)).text();
  assert.match(html, /No battles found/);
});

test('the battle detection settings are adjustable from the query', async () => {
  const html = await (await fetch(`${base}/battle?scan=90d&min=1&gap=45`)).text();
  assert.match(html, /within 45 minutes/);
});

test('a battle report can be anchored to a single killmail', async () => {
  const list = await (await fetch(`${base}/api/killmails`)).json();
  const id = list.killmails[0].id;

  const res = await fetch(`${base}/battle/report?kill=${id}`);
  assert.equal(res.status, 200);

  const html = await res.text();
  assert.match(html, /one detected battle/, 'the report states it covers a single battle');
  assert.match(html, /EF Zeta/);
});

test('an anchor that is not a killmail 404s', async () => {
  assert.equal((await fetch(`${base}/battle/report?kill=999999`)).status, 404);
});

test('detected battles link to their anchored report', async () => {
  const html = await (await fetch(`${base}/battle?scan=90d&min=1`)).text();
  assert.match(html, /href="\/battle\/report\?kill=\d+"/);
});

test('a battle report can be built from a hand-picked list of killmails', async () => {
  const list = await (await fetch(`${base}/api/killmails`)).json();
  const ids = list.killmails.map((k) => k.id);

  const res = await fetch(`${base}/battle/report?ids=${ids.join(',')}`);
  assert.equal(res.status, 200);

  const html = await res.text();
  assert.match(html, /hand-picked selection|selected killmail/i);
  assert.match(html, /EF Zeta/);
});

test('a selection of unknown ids 404s rather than reporting on nothing', async () => {
  assert.equal((await fetch(`${base}/battle/report?ids=999998,999999`)).status, 404);
});

test('junk in the ids parameter is ignored', async () => {
  const list = await (await fetch(`${base}/api/killmails`)).json();
  const id = list.killmails[0].id;

  const res = await fetch(`${base}/battle/report?ids=${id},abc,-4,0,${id}`);
  assert.equal(res.status, 200, 'the one valid id still builds a report');
});

test('the killmails page offers a range picker wired to the report', async () => {
  const html = await (await fetch(`${base}/kills`)).text();
  assert.match(html, /action="\/battle\/report"/);
  assert.match(html, /name="ids"/);
  assert.match(html, /role="slider"/);
  assert.match(html, /data-kill-id="\d+"/);
});

test('the kill page links to a battle report around that kill', async () => {
  const list = await (await fetch(`${base}/api/killmails`)).json();
  const html = await (await fetch(`${base}/kill/${list.killmails[0].id}`)).text();

  const match = html.match(/href="(\/battle\/report\?[^"]+)"/);
  assert.ok(match, 'kill page should carry a battle report link');

  const target = match[1].replace(/&amp;/g, '&');
  const report = await fetch(base + target);
  assert.equal(report.status, 200);
  assert.match(await report.text(), /EF Zeta/);
});

test('unknown pages return 404', async () => {
  const res = await fetch(`${base}/kill/999999`);
  assert.equal(res.status, 404);
});
