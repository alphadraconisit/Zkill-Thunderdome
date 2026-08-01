'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { analyseBattle, entityOf, formatDuration } = require('../src/battle');
const { damageTimeline, compactNumber } = require('../src/chart');

let nextId = 1;

/** Builds a killmail plus its attacker rows in the shape the queries return. */
function kill({ at, victim, corp, alliance, ship = 'Rifter', system = 'Ahbazon', damage, attackers }) {
  const id = nextId++;
  const total = attackers.reduce((sum, a) => sum + a.damage, 0);
  return {
    kill: {
      id,
      killed_at: at,
      victim_name: victim,
      victim_corp: corp,
      victim_alliance: alliance || null,
      ship,
      system,
      security: 0.4,
      damage_taken: damage ?? total,
      attacker_count: attackers.length,
      final_blow: attackers[0].name,
    },
    attackers: attackers.map((a) => ({
      killmail_id: id,
      name: a.name,
      corp: a.corp,
      alliance: a.alliance || null,
      ship: a.ship || 'Machariel',
      weapon: a.ship || 'Machariel',
      damage: a.damage,
      final_blow: 0,
    })),
  };
}

function battle(entries) {
  return analyseBattle(entries.map((e) => e.kill), entries.flatMap((e) => e.attackers));
}

test('entityOf falls back alliance -> corp -> pilot', () => {
  assert.equal(entityOf('Ahbazon-Prime', 'Endless-Fury', 'EF Zeta').label, 'Ahbazon-Prime');
  assert.equal(entityOf(null, 'Endless-Fury', 'EF Zeta').label, 'Endless-Fury');
  assert.equal(entityOf(null, null, 'EF Zeta').label, 'EF Zeta');
  assert.equal(entityOf(null, null, 'EF Zeta').kind, 'character');
});

test('a one-sided gank splits into attacker and victim sides', () => {
  const report = battle([
    kill({
      at: '2026-07-30T21:00:00.000Z',
      victim: 'Yrgrasil', corp: 'EVE University', alliance: 'Ivy League',
      ship: 'Prophecy Navy Issue', damage: 30000,
      attackers: [
        { name: 'Mandek', corp: '0nly Fleets', alliance: 'Only Alts', damage: 20000 },
        { name: 'Trony', corp: '0nly Fleets', alliance: 'Only Alts', damage: 10000 },
      ],
    }),
  ]);

  assert.equal(report.teams.length, 2);

  const [attackerSide, victimSide] = report.teams;
  assert.equal(attackerSide.label, 'Only Alts');
  assert.equal(attackerSide.pilotCount, 2);
  assert.equal(attackerSide.kills, 1);
  assert.equal(attackerSide.losses, 0);
  assert.equal(attackerSide.damageDone, 30000);

  assert.equal(victimSide.label, 'Ivy League');
  assert.equal(victimSide.losses, 1);
  assert.equal(victimSide.kills, 0);
  assert.equal(victimSide.damageTaken, 30000);
});

test('each alliance is its own side, even when they shoot together', () => {
  const report = battle([
    kill({
      at: '2026-07-30T21:00:00.000Z',
      victim: 'Victim One', corp: 'Target Corp', alliance: 'Target Alliance',
      attackers: [
        { name: 'Ally A', corp: 'Corp A', alliance: 'Alliance A', damage: 5000 },
        { name: 'Ally B', corp: 'Corp B', alliance: 'Alliance B', damage: 3000 },
      ],
    }),
  ]);

  assert.equal(report.teams.length, 3, 'two attacking alliances plus the victim');
  assert.deepEqual(
    report.teams.map((t) => t.label),
    ['Alliance A', 'Alliance B', 'Target Alliance'],
    'sides are listed by damage dealt'
  );

  const a = report.teams.find((t) => t.label === 'Alliance A');
  const b = report.teams.find((t) => t.label === 'Alliance B');
  assert.equal(a.damageDone, 5000);
  assert.equal(b.damageDone, 3000);
  assert.equal(a.kills, 1);
  assert.equal(b.kills, 1, 'both alliances are credited with the kill');
});

test('attackers are never folded into the side of the pilot they killed', () => {
  // The regression that collapsed a real report into a single side: an
  // attacker appearing on a mail must not join the victim's alliance.
  const report = battle([
    kill({
      at: '2026-07-30T21:00:00.000Z',
      victim: 'Uni One', corp: 'EVE University', alliance: null,
      attackers: [{ name: 'Raider', corp: '0nly Fleets', alliance: null, damage: 9000 }],
    }),
    kill({
      at: '2026-07-30T21:04:00.000Z',
      victim: 'Uni Two', corp: 'EVE University', alliance: null,
      attackers: [
        { name: 'Raider', corp: '0nly Fleets', alliance: null, damage: 7000 },
        { name: 'Raider Two', corp: '0nly Fleets', alliance: null, damage: 2000 },
      ],
    }),
  ]);

  assert.equal(report.teams.length, 2);

  const raiders = report.teams.find((t) => t.label === '0nly Fleets');
  const uni = report.teams.find((t) => t.label === 'EVE University');

  assert.equal(raiders.kills, 2);
  assert.equal(raiders.losses, 0);
  assert.equal(uni.kills, 0);
  assert.equal(uni.losses, 2);
  assert.equal(raiders.pilotCount, 2);
  assert.equal(uni.pilotCount, 2);
});

test('a side tracks the corporations flying under it', () => {
  const report = battle([
    kill({
      at: '2026-07-30T21:00:00.000Z',
      victim: 'Victim', corp: 'Target Corp', alliance: 'Target Alliance',
      attackers: [
        { name: 'Pilot A', corp: 'First Corp', alliance: 'Big Alliance', damage: 5000 },
        { name: 'Pilot B', corp: 'Second Corp', alliance: 'Big Alliance', damage: 3000 },
      ],
    }),
  ]);

  const big = report.teams.find((t) => t.label === 'Big Alliance');
  assert.equal(big.pilotCount, 2);
  assert.equal(big.corpCount, 2);
  assert.deepEqual(big.corpList, ['First Corp', 'Second Corp']);
  assert.equal(big.damageDone, 8000);
});

test('a two-sided fight keeps each side on its own team when both trade kills', () => {
  const report = battle([
    kill({
      at: '2026-07-30T21:00:00.000Z',
      victim: 'Red One', corp: 'Red Corp', alliance: 'Reds',
      attackers: [
        { name: 'Blue One', corp: 'Blue Corp', alliance: 'Blues', damage: 4000 },
        { name: 'Blue Two', corp: 'Blue Corp', alliance: 'Blues', damage: 1000 },
      ],
    }),
    kill({
      at: '2026-07-30T21:05:00.000Z',
      victim: 'Blue Two', corp: 'Blue Corp', alliance: 'Blues',
      attackers: [
        { name: 'Red Two', corp: 'Red Corp', alliance: 'Reds', damage: 3000 },
      ],
    }),
  ]);

  assert.equal(report.teams.length, 2);

  const blues = report.teams.find((t) => t.label === 'Blues');
  const reds = report.teams.find((t) => t.label === 'Reds');

  assert.equal(blues.kills, 1);
  assert.equal(blues.losses, 1);
  assert.equal(blues.damageDone, 5000);
  assert.equal(blues.damageTaken, 3000);

  assert.equal(reds.kills, 1);
  assert.equal(reds.losses, 1);
  assert.equal(reds.damageDone, 3000);
  assert.equal(reds.damageTaken, 5000);
});

test('a pilot who both deals and takes damage is counted on one side only', () => {
  const report = battle([
    kill({
      at: '2026-07-30T21:00:00.000Z',
      victim: 'Red One', corp: 'Red Corp', alliance: 'Reds',
      attackers: [{ name: 'Blue One', corp: 'Blue Corp', alliance: 'Blues', damage: 4000 }],
    }),
    kill({
      at: '2026-07-30T21:10:00.000Z',
      victim: 'Blue One', corp: 'Blue Corp', alliance: 'Blues', damage: 2500,
      attackers: [{ name: 'Red Two', corp: 'Red Corp', alliance: 'Reds', damage: 2500 }],
    }),
  ]);

  const blues = report.teams.find((t) => t.label === 'Blues');
  assert.equal(blues.pilotCount, 1);

  const blueOne = blues.pilots[0];
  assert.equal(blueOne.name, 'Blue One');
  assert.equal(blueOne.damageDone, 4000);
  assert.equal(blueOne.damageTaken, 2500);
  assert.equal(blueOne.shipsLost, 1);
  assert.equal(blueOne.kills, 1);
});

test('pilots with no alliance fall back to their corporation as the side', () => {
  const report = battle([
    kill({
      at: '2026-07-30T21:00:00.000Z',
      victim: 'Lone Miner', corp: 'Mining Co', alliance: null,
      attackers: [{ name: 'Ganker', corp: 'Gank Co', alliance: null, damage: 1200 }],
    }),
  ]);

  assert.deepEqual(report.teams.map((t) => t.label).sort(), ['Gank Co', 'Mining Co']);
  assert.equal(report.teams.every((t) => t.kind === 'corporation'), true);
});

test('the summary reports duration, systems and totals', () => {
  const report = battle([
    kill({
      at: '2026-07-30T21:00:00.000Z', system: 'Ahbazon',
      victim: 'A', corp: 'CorpA', alliance: 'AllA',
      attackers: [{ name: 'B', corp: 'CorpB', alliance: 'AllB', damage: 1000 }],
    }),
    kill({
      at: '2026-07-30T22:30:00.000Z', system: 'Jita',
      victim: 'C', corp: 'CorpA', alliance: 'AllA',
      attackers: [{ name: 'B', corp: 'CorpB', alliance: 'AllB', damage: 500 }],
    }),
  ]);

  assert.equal(report.summary.killmails, 2);
  assert.equal(report.summary.damage, 1500);
  assert.equal(report.summary.pilots, 3);
  assert.deepEqual(report.summary.systems, ['Ahbazon', 'Jita']);
  assert.equal(report.summary.durationMs, 90 * 60 * 1000);
  assert.equal(formatDuration(report.summary.durationMs), '1h 30m');
});

test('the timeline accumulates damage per side and never decreases', () => {
  const report = battle([
    kill({
      at: '2026-07-30T21:00:00.000Z',
      victim: 'Red One', corp: 'Red Corp', alliance: 'Reds',
      attackers: [{ name: 'Blue One', corp: 'Blue Corp', alliance: 'Blues', damage: 4000 }],
    }),
    kill({
      at: '2026-07-30T21:05:00.000Z',
      victim: 'Red Two', corp: 'Red Corp', alliance: 'Reds',
      attackers: [{ name: 'Blue One', corp: 'Blue Corp', alliance: 'Blues', damage: 2000 }],
    }),
  ]);

  const blues = report.timeline.series.find((s) => s.label === 'Blues');
  assert.deepEqual(blues.points.map((p) => p.v), [0, 4000, 6000]);
  assert.equal(blues.total, 6000);

  for (const series of report.timeline.series) {
    for (let i = 1; i < series.points.length; i++) {
      assert.ok(series.points[i].v >= series.points[i - 1].v, 'cumulative damage must not fall');
    }
  }
});

test('an empty window produces an empty report rather than throwing', () => {
  const report = analyseBattle([], []);
  assert.deepEqual(report.teams, []);
  assert.equal(report.summary.killmails, 0);
  assert.equal(damageTimeline(report.timeline.series), null);
});

test('the chart maps values onto the plot area', () => {
  const report = battle([
    kill({
      at: '2026-07-30T21:00:00.000Z',
      victim: 'Red One', corp: 'Red Corp', alliance: 'Reds',
      attackers: [{ name: 'Blue One', corp: 'Blue Corp', alliance: 'Blues', damage: 4000 }],
    }),
    kill({
      at: '2026-07-30T22:00:00.000Z',
      victim: 'Red Two', corp: 'Red Corp', alliance: 'Reds',
      attackers: [{ name: 'Blue One', corp: 'Blue Corp', alliance: 'Blues', damage: 4000 }],
    }),
  ]);

  const chart = damageTimeline(report.timeline.series);
  assert.ok(chart.lines.length >= 1);

  const blues = chart.lines.find((l) => l.label === 'Blues');
  assert.match(blues.d, /^M[\d.]+,[\d.]+/);
  assert.equal(blues.total, 8000);

  // Every drawn point stays inside the plot rectangle.
  const top = chart.plot.y;
  const bottom = chart.plot.y + chart.plot.h;
  assert.ok(blues.last.y >= top - 0.5 && blues.last.y <= bottom + 0.5);
  assert.ok(blues.last.x <= chart.plot.x + chart.plot.w + 0.5);

  // Each hover column carries a value for every series.
  assert.ok(chart.columns.length > 0);
  for (const column of chart.columns) {
    assert.equal(column.values.length, chart.lines.length);
  }

  // Colours come from the fixed categorical order.
  assert.equal(chart.lines[0].color, '#3987e5');
  if (chart.lines[1]) assert.equal(chart.lines[1].color, '#d95926');
});

test('a battle that lasts an instant still produces a chart', () => {
  const report = battle([
    kill({
      at: '2026-07-30T21:00:00.000Z',
      victim: 'Red One', corp: 'Red Corp', alliance: 'Reds',
      attackers: [{ name: 'Blue One', corp: 'Blue Corp', alliance: 'Blues', damage: 4000 }],
    }),
  ]);

  const chart = damageTimeline(report.timeline.series);
  assert.ok(chart, 'a zero-length span must not divide by zero');
  assert.ok(Number.isFinite(chart.lines[0].last.x));
});

test('compactNumber shortens large damage figures', () => {
  assert.equal(compactNumber(950), '950');
  assert.equal(compactNumber(5787), '5.8k');
  assert.equal(compactNumber(35977), '36k');
  assert.equal(compactNumber(1500000), '1.5M');
});


// --- ship-loss lane ---------------------------------------------------------

test('each ship lost gets a marker positioned at the time it died', () => {
  const report = battle([
    kill({
      at: '2026-07-30T21:00:00.000Z',
      victim: 'Red One', corp: 'Red Corp', alliance: 'Reds', ship: 'Rifter',
      attackers: [{ name: 'Blue One', corp: 'Blue Corp', alliance: 'Blues', damage: 4000 }],
    }),
    kill({
      at: '2026-07-30T21:30:00.000Z',
      victim: 'Red Two', corp: 'Red Corp', alliance: 'Reds', ship: 'Ferox',
      attackers: [{ name: 'Blue One', corp: 'Blue Corp', alliance: 'Blues', damage: 4000 }],
    }),
  ]);

  const losses = [
    { t: Date.parse('2026-07-30T21:00:00.000Z'), id: 1, ship: 'Rifter', victim: 'Red One', sideIndex: 1 },
    { t: Date.parse('2026-07-30T21:30:00.000Z'), id: 2, ship: 'Ferox', victim: 'Red Two', sideIndex: 1 },
  ];

  const chart = damageTimeline(report.timeline.series, losses);
  assert.equal(chart.losses.length, 2);

  // Both sit under the plot, and the later loss is further right.
  for (const marker of chart.losses) {
    assert.ok(marker.y > chart.plot.y + chart.plot.h, 'markers sit below the axis');
    assert.ok(marker.x >= chart.plot.x);
    assert.ok(marker.x + chart.lossSize <= chart.plot.x + chart.plot.w + 0.5);
  }
  assert.ok(chart.losses[1].x > chart.losses[0].x);
  assert.equal(chart.losses[0].lane, 0);
  assert.equal(chart.losses[1].lane, 0, 'well-separated losses share one lane');
});

test('losses at the same moment stack into separate lanes', () => {
  const report = battle([
    kill({
      at: '2026-07-30T21:00:00.000Z',
      victim: 'Red One', corp: 'Red Corp', alliance: 'Reds',
      attackers: [{ name: 'Blue One', corp: 'Blue Corp', alliance: 'Blues', damage: 4000 }],
    }),
    kill({
      at: '2026-07-30T21:20:00.000Z',
      victim: 'Red Two', corp: 'Red Corp', alliance: 'Reds',
      attackers: [{ name: 'Blue One', corp: 'Blue Corp', alliance: 'Blues', damage: 4000 }],
    }),
  ]);

  const at = Date.parse('2026-07-30T21:00:00.000Z');
  const losses = [
    { t: at, id: 1, ship: 'Drekavac', victim: 'Red One', sideIndex: 1 },
    { t: at, id: 2, ship: 'Capsule', victim: 'Red One', sideIndex: 1 },
    { t: at + 1000, id: 3, ship: 'Ferox', victim: 'Red Two', sideIndex: 1 },
  ];

  const chart = damageTimeline(report.timeline.series, losses);
  assert.deepEqual(chart.losses.map((l) => l.lane), [0, 1, 2],
    'three near-simultaneous losses take three lanes rather than overlapping');

  // Lanes are stacked downwards, one marker height apart.
  assert.ok(chart.losses[1].y > chart.losses[0].y);
  assert.ok(chart.losses[2].y > chart.losses[1].y);
});

test('the chart grows to fit the loss lane, and stays plot-sized without one', () => {
  const report = battle([
    kill({
      at: '2026-07-30T21:00:00.000Z',
      victim: 'Red One', corp: 'Red Corp', alliance: 'Reds',
      attackers: [{ name: 'Blue One', corp: 'Blue Corp', alliance: 'Blues', damage: 4000 }],
    }),
  ]);

  const bare = damageTimeline(report.timeline.series, []);
  const withLoss = damageTimeline(report.timeline.series, [
    { t: Date.parse('2026-07-30T21:00:00.000Z'), id: 1, ship: 'Rifter', victim: 'Red One', sideIndex: 0 },
  ]);

  assert.equal(bare.losses.length, 0);
  assert.ok(withLoss.viewHeight > bare.viewHeight, 'the lane adds height rather than overlapping the plot');
});
