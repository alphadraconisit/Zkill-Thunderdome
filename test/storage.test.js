'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'thunderdome-storage-'));
process.env.TURSO_DATABASE_URL = `file:${path.join(TMP, 'test.db')}`;
process.env.ESI_LOOKUP = '0';

const { migrate, get, all, run, storeKillmail, deleteKillmail } = require('../src/db');
const { parseKillmail } = require('../src/parser');
const esi = require('../src/esi');

const SAMPLE = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-killmail.txt'), 'utf8');

test.before(async () => {
  await migrate();
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('migrate is idempotent', async () => {
  await migrate();
  await migrate();
  const row = await get("SELECT name FROM sqlite_master WHERE type='table' AND name='killmails'");
  assert.equal(row.name, 'killmails');
});

test('storing a killmail writes the mail, its attackers and its items', async () => {
  const km = parseKillmail(SAMPLE);
  const { id, duplicate } = await storeKillmail(km);

  assert.equal(duplicate, false);
  assert.ok(id > 0);

  const stored = await get('SELECT * FROM killmails WHERE id = @id', { id });
  assert.equal(stored.victim_name, 'DraconisBeta');
  assert.equal(stored.attacker_count, 5);
  assert.equal(stored.total_damage, 5787);
  assert.equal(stored.final_blow, 'EF Delta');

  const attackers = await all('SELECT * FROM attackers WHERE killmail_id = @id ORDER BY position', { id });
  assert.equal(attackers.length, 5);
  assert.equal(attackers[0].name, 'EF Zeta');
  assert.equal(attackers[0].damage, 2763);
  assert.equal(attackers.filter((a) => a.final_blow === 1).length, 1);

  const items = await all('SELECT * FROM items WHERE killmail_id = @id', { id });
  assert.equal(items.filter((i) => i.status === 'destroyed').length, 30);
  assert.equal(items.filter((i) => i.status === 'dropped').length, 22);
});

test('storing the same killmail twice does not duplicate rows', async () => {
  const km = parseKillmail(SAMPLE);
  const again = await storeKillmail(km);
  assert.equal(again.duplicate, true);

  const { n } = await get('SELECT COUNT(*) AS n FROM killmails');
  assert.equal(n, 1);
});

test('deleting a killmail removes its attackers and items too', async () => {
  const existing = await get('SELECT id FROM killmails LIMIT 1');
  assert.ok(existing, 'expected the sample killmail to still be present');

  assert.equal(await deleteKillmail(existing.id), true);

  assert.equal((await get('SELECT COUNT(*) AS n FROM killmails')).n, 0);
  assert.equal((await get('SELECT COUNT(*) AS n FROM attackers')).n, 0);
  assert.equal((await get('SELECT COUNT(*) AS n FROM items')).n, 0);
});

test('deleting a killmail that is not there reports no change', async () => {
  assert.equal(await deleteKillmail(999999), false);
});

test('a failed insert leaves nothing behind', async () => {
  const km = parseKillmail(SAMPLE);
  // A killmail whose attacker list cannot be written must not leave the parent
  // row committed on its own.
  const broken = { ...km, attackers: [{ ...km.attackers[0], name: null }] };

  await assert.rejects(() => storeKillmail(broken));
  assert.equal((await get('SELECT COUNT(*) AS n FROM killmails')).n, 0);
  assert.equal((await get('SELECT COUNT(*) AS n FROM attackers')).n, 0);
});

test('the artwork cache round-trips through the database', async () => {
  await esi.loadCache();
  assert.equal(esi.typeIdFor('Machariel'), null);

  await run("INSERT INTO type_ids (name, type_id) VALUES ('Machariel', 17738)");
  await esi.loadCache();
  assert.equal(esi.typeIdFor('Machariel'), 17738);
  assert.equal(esi.typeIdFor('machariel'), 17738, 'lookup should be case-insensitive');
  assert.match(esi.shipImage('Machariel', 64), /types\/17738\/render\?size=64/);
  assert.equal(esi.shipImage('Nonexistent Hull'), null);
});
