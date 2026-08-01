'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectBattles } = require('../src/battles');

let nextId = 1;
const BASE = Date.UTC(2026, 6, 30, 19, 0, 0);

/** A killmail `minute` minutes into the scenario, in `system`. */
function kill({ minute, system = 'AAS-8R', victim, valliance, ship = 'Rifter', attackers }) {
  const id = nextId++;
  return {
    kill: {
      id,
      killed_at: new Date(BASE + minute * 60000).toISOString(),
      system,
      victim_name: victim,
      victim_corp: `${valliance} Corp`,
      victim_alliance: valliance,
      ship,
      damage_taken: attackers.reduce((s, a) => s + a.damage, 0),
    },
    attackers: attackers.map((a) => ({
      killmail_id: id,
      name: a.name,
      corp: `${a.alliance} Corp`,
      alliance: a.alliance,
      damage: a.damage,
    })),
  };
}

function detect(entries, options) {
  return detectBattles(entries.map((e) => e.kill), entries.flatMap((e) => e.attackers), options);
}

test('consecutive related kills form one battle', () => {
  const battles = detect([
    kill({ minute: 0, victim: 'Red 1', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 5000 }] }),
    kill({ minute: 6, victim: 'Red 2', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 4000 }] }),
    kill({ minute: 13, victim: 'Blue 1', valliance: 'Blues', attackers: [{ name: 'Red 3', alliance: 'Reds', damage: 6000 }] }),
  ]);

  assert.equal(battles.length, 1);
  assert.equal(battles[0].killCount, 3);
  assert.equal(battles[0].system, 'AAS-8R');
  assert.equal(battles[0].durationMs, 13 * 60000);
  assert.equal(battles[0].damage, 15000);
});

test('a long quiet gap splits one fight into two battles', () => {
  const battles = detect([
    kill({ minute: 0, victim: 'Red 1', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 5000 }] }),
    kill({ minute: 4, victim: 'Red 2', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 5000 }] }),
    // 45 minutes later the same people fight again — a separate engagement.
    kill({ minute: 49, victim: 'Red 3', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 5000 }] }),
    kill({ minute: 53, victim: 'Red 4', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 5000 }] }),
  ], { gapMinutes: 20 });

  assert.equal(battles.length, 2);
  assert.deepEqual(battles.map((b) => b.killCount), [2, 2]);
  // Most recent first.
  assert.ok(battles[0].startMs > battles[1].startMs);
});

test('unrelated pilots in the same system at the same time are separate battles', () => {
  const battles = detect([
    kill({ minute: 0, victim: 'Red 1', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 5000 }] }),
    kill({ minute: 2, victim: 'Red 2', valliance: 'Reds', attackers: [{ name: 'Blue 2', alliance: 'Blues', damage: 5000 }] }),
    // Completely different people, minutes apart, same system.
    kill({ minute: 3, victim: 'Green 1', valliance: 'Greens', attackers: [{ name: 'Yellow 1', alliance: 'Yellows', damage: 3000 }] }),
    kill({ minute: 5, victim: 'Green 2', valliance: 'Greens', attackers: [{ name: 'Yellow 1', alliance: 'Yellows', damage: 3000 }] }),
  ]);

  assert.equal(battles.length, 2);
  const labels = battles.map((b) => b.sides.map((s) => s.label).sort().join('+')).sort();
  assert.deepEqual(labels, ['Blues', 'Yellows']);
});

test('the same fight in two systems is two battles', () => {
  const battles = detect([
    kill({ minute: 0, system: 'AAS-8R', victim: 'Red 1', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 5000 }] }),
    kill({ minute: 2, system: 'AAS-8R', victim: 'Red 2', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 5000 }] }),
    kill({ minute: 4, system: 'Jita', victim: 'Red 3', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 5000 }] }),
    kill({ minute: 6, system: 'Jita', victim: 'Red 4', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 5000 }] }),
  ]);

  assert.equal(battles.length, 2);
  assert.deepEqual(battles.map((b) => b.system).sort(), ['AAS-8R', 'Jita']);
});

test('a kill bridging two skirmishes merges them into one battle', () => {
  const battles = detect([
    // Two independent skirmishes running in parallel.
    kill({ minute: 0, victim: 'Red 1', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 5000 }] }),
    kill({ minute: 1, victim: 'Green 1', valliance: 'Greens', attackers: [{ name: 'Yellow 1', alliance: 'Yellows', damage: 5000 }] }),
    // Blues and Yellows now shoot the same target: one fight.
    kill({ minute: 5, victim: 'Red 2', valliance: 'Reds', attackers: [
      { name: 'Blue 1', alliance: 'Blues', damage: 3000 },
      { name: 'Yellow 1', alliance: 'Yellows', damage: 3000 },
    ] }),
  ]);

  assert.equal(battles.length, 1);
  assert.equal(battles[0].killCount, 3);
  // Red 1, Red 2, Green 1, Blue 1 and Yellow 1 — the last two appear twice.
  assert.equal(battles[0].pilotCount, 5, 'every pilot from both skirmishes, counted once');
});

test('a lone killmail is not reported as a battle', () => {
  const battles = detect([
    kill({ minute: 0, victim: 'Solo', valliance: 'Miners', attackers: [{ name: 'Ganker', alliance: 'Pirates', damage: 1200 }] }),
  ]);
  assert.deepEqual(battles, []);
});

test('minKills of 1 surfaces solo kills too', () => {
  const battles = detect([
    kill({ minute: 0, victim: 'Solo', valliance: 'Miners', attackers: [{ name: 'Ganker', alliance: 'Pirates', damage: 1200 }] }),
  ], { minKills: 1 });

  assert.equal(battles.length, 1);
  assert.equal(battles[0].killCount, 1);
  assert.equal(battles[0].durationMs, 0, 'a single kill has no duration');
});

test('the gap is configurable', () => {
  const entries = [
    kill({ minute: 0, victim: 'Red 1', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 5000 }] }),
    kill({ minute: 12, victim: 'Red 2', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 5000 }] }),
  ];

  assert.equal(detect(entries, { gapMinutes: 20 }).length, 1, '12 minutes is inside a 20 minute gap');
  assert.equal(detect(entries, { gapMinutes: 10 }).length, 0,
    'with a 10 minute gap they are two lone kills, which are filtered out');
  assert.equal(detect(entries, { gapMinutes: 10, minKills: 1 }).length, 2);
});

test('battles report their sides ranked by damage dealt', () => {
  const battles = detect([
    kill({ minute: 0, victim: 'Red 1', valliance: 'Reds', attackers: [
      { name: 'Blue 1', alliance: 'Blues', damage: 9000 },
      { name: 'Green 1', alliance: 'Greens', damage: 1000 },
    ] }),
    kill({ minute: 3, victim: 'Blue 1', valliance: 'Blues', attackers: [
      { name: 'Red 2', alliance: 'Reds', damage: 4000 },
    ] }),
  ]);

  assert.equal(battles.length, 1);
  assert.deepEqual(battles[0].sides.map((s) => s.label), ['Blues', 'Reds', 'Greens']);
  assert.equal(battles[0].sides[0].damage, 9000);
  assert.equal(battles[0].sideCount, 3);
});

test('participants are counted once even across many kills', () => {
  const battles = detect([
    kill({ minute: 0, victim: 'Red 1', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 100 }] }),
    kill({ minute: 2, victim: 'Red 2', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 100 }] }),
    kill({ minute: 4, victim: 'Red 3', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 100 }] }),
  ]);

  // Blue 1 plus three distinct victims.
  assert.equal(battles[0].pilotCount, 4);
});

test('killmails arriving out of order still cluster correctly', () => {
  const entries = [
    kill({ minute: 0, victim: 'Red 1', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 5000 }] }),
    kill({ minute: 8, victim: 'Red 2', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 5000 }] }),
    kill({ minute: 4, victim: 'Red 3', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 5000 }] }),
  ];

  const battles = detect(entries);
  assert.equal(battles.length, 1);
  assert.equal(battles[0].killCount, 3);
  assert.equal(battles[0].startMs, BASE);
  assert.equal(battles[0].endMs, BASE + 8 * 60000);
});

test('an empty board yields no battles', () => {
  assert.deepEqual(detectBattles([], []), []);
});

test('detection is deterministic', () => {
  const entries = [
    kill({ minute: 0, victim: 'Red 1', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 5000 }] }),
    kill({ minute: 5, victim: 'Red 2', valliance: 'Reds', attackers: [{ name: 'Blue 2', alliance: 'Blues', damage: 5000 }] }),
    kill({ minute: 30, victim: 'Green 1', valliance: 'Greens', attackers: [{ name: 'Yellow 1', alliance: 'Yellows', damage: 5000 }] }),
    kill({ minute: 33, victim: 'Green 2', valliance: 'Greens', attackers: [{ name: 'Yellow 1', alliance: 'Yellows', damage: 5000 }] }),
  ];

  const once = JSON.stringify(detect(entries));
  const twice = JSON.stringify(detect(entries));
  assert.equal(once, twice);
});


// --- one ship loss per pilot per battle -------------------------------------

test('a pilot losing a second ship starts a new battle, however close in time', () => {
  const battles = detect([
    kill({ minute: 0, victim: 'Red 1', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 5000 }] }),
    kill({ minute: 2, victim: 'Red 2', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 5000 }] }),
    // Red 1 re-shipped and came back: everything from here is a second battle.
    kill({ minute: 6, victim: 'Red 1', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 5000 }] }),
    kill({ minute: 8, victim: 'Red 3', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 5000 }] }),
  ]);

  assert.equal(battles.length, 2, 'the repeat loss splits the run in two');
  assert.deepEqual(battles.map((b) => b.killCount), [2, 2]);
});

test('every pilot loses at most one ship in any detected battle', () => {
  const entries = [
    kill({ minute: 0, victim: 'Red 1', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 100 }] }),
    kill({ minute: 3, victim: 'Red 2', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 100 }] }),
    kill({ minute: 5, victim: 'Red 1', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 100 }] }),
    kill({ minute: 7, victim: 'Red 2', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 100 }] }),
    kill({ minute: 9, victim: 'Red 1', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 100 }] }),
  ];

  const victimById = new Map(entries.map((e) => [e.kill.id, e.kill.victim_name]));
  const battles = detect(entries, { minKills: 1 });

  // The invariant the whole rule exists to guarantee.
  for (const battle of battles) {
    const seen = new Set();
    for (const id of battle.killIds) {
      const victim = victimById.get(id);
      assert.ok(!seen.has(victim), `${victim} lost two ships inside one battle`);
      seen.add(victim);
    }
  }

  // Five losses across three pilots-worth of re-shipping: Red 1 dies three
  // times, so there are three battles.
  assert.equal(battles.length, 3);
  assert.equal(battles.reduce((n, b) => n + b.killCount, 0), 5, 'no killmail is dropped');
});

test('a pod loss stays in the same battle as the ship it came from', () => {
  const battles = detect([
    kill({ minute: 0, victim: 'Red 1', valliance: 'Reds', ship: 'Drekavac', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 9000 }] }),
    kill({ minute: 0, victim: 'Red 1', valliance: 'Reds', ship: 'Capsule', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 400 }] }),
    kill({ minute: 4, victim: 'Red 2', valliance: 'Reds', ship: 'Ferox', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 7000 }] }),
  ]);

  assert.equal(battles.length, 1, 'a pod is not a second ship loss');
  assert.equal(battles[0].killCount, 3);
});

test('named capsule variants are still treated as pods', () => {
  const battles = detect([
    kill({ minute: 0, victim: 'Red 1', valliance: 'Reds', ship: 'Drekavac', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 9000 }] }),
    kill({ minute: 1, victim: 'Red 1', valliance: 'Reds', ship: "Capsule - Genolution 'Auroral' 197-variant", attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 400 }] }),
  ]);

  assert.equal(battles.length, 1);
  assert.equal(battles[0].killCount, 2);
});

test('two pilots re-shipping does not fuse the follow-up battles together', () => {
  const battles = detect([
    kill({ minute: 0, victim: 'Red 1', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 100 }] }),
    kill({ minute: 1, victim: 'Red 2', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 100 }] }),
    kill({ minute: 10, victim: 'Red 1', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 100 }] }),
    kill({ minute: 11, victim: 'Red 2', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 100 }] }),
  ]);

  assert.equal(battles.length, 2);
  assert.deepEqual(battles.map((b) => b.killCount), [2, 2]);
});

test('findBattleContaining returns the single battle an anchor belongs to', () => {
  const { findBattleContaining } = require('../src/battles');
  const entries = [
    kill({ minute: 0, victim: 'Red 1', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 100 }] }),
    kill({ minute: 2, victim: 'Red 2', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 100 }] }),
    kill({ minute: 90, victim: 'Red 3', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 100 }] }),
    kill({ minute: 92, victim: 'Red 4', valliance: 'Reds', attackers: [{ name: 'Blue 1', alliance: 'Blues', damage: 100 }] }),
  ];
  const kills = entries.map((e) => e.kill);
  const attackers = entries.flatMap((e) => e.attackers);

  const first = findBattleContaining(kills, attackers, kills[0].id);
  assert.equal(first.killCount, 2);
  assert.deepEqual(first.killIds, [kills[0].id, kills[1].id]);

  const later = findBattleContaining(kills, attackers, kills[3].id);
  assert.deepEqual(later.killIds, [kills[2].id, kills[3].id]);

  assert.equal(findBattleContaining(kills, attackers, 99999), null);
});
