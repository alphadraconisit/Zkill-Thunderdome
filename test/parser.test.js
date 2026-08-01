'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseKillmail, splitKillmails, parseItemLine } = require('../src/parser');

const SAMPLE = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-killmail.txt'), 'utf8');

test('parses the header block', () => {
  const km = parseKillmail(SAMPLE);
  assert.equal(km.killedAt, '2026-06-27T15:33:15.000Z');
  assert.equal(km.victim.name, 'DraconisBeta');
  assert.equal(km.victim.corp, 'Goat Trading Institute');
  assert.equal(km.victim.alliance, 'OnlyAlts.');
  assert.equal(km.victim.ship, 'Crane');
  assert.equal(km.victim.system, 'Ahbazon');
  assert.equal(km.victim.security, 0.4);
  assert.equal(km.victim.damageTaken, 5787);
});

test('treats "Unknown" and "None" as empty', () => {
  const km = parseKillmail(SAMPLE);
  assert.equal(km.victim.faction, null);
  assert.equal(km.attackers[0].faction, null);
});

test('parses every attacker and sorts them by damage', () => {
  const km = parseKillmail(SAMPLE);
  assert.equal(km.attackers.length, 5);
  assert.deepEqual(km.attackers.map((a) => a.name), ['EF Zeta', 'EF Beta', 'EF Alpha', 'EF Sigma', 'EF Delta']);
  assert.deepEqual(km.attackers.map((a) => a.damage), [2763, 1192, 1148, 375, 309]);
  assert.equal(km.totalDamage, 5787);
});

test('identifies the final blow and strips the marker from the name', () => {
  const km = parseKillmail(SAMPLE);
  assert.equal(km.finalBlow.name, 'EF Delta');
  assert.equal(km.finalBlow.weapon, 'Imperial Navy Large EMP Smartbomb');
  assert.equal(km.attackers.filter((a) => a.finalBlow).length, 1);
});

test('captures attacker detail fields', () => {
  const km = parseKillmail(SAMPLE);
  const zeta = km.attackers[0];
  assert.equal(zeta.security, -10);
  assert.equal(zeta.corp, 'Endless-Fury');
  assert.equal(zeta.alliance, 'Ahbazon-Prime');
  assert.equal(zeta.ship, 'Machariel');
  assert.equal(zeta.weapon, 'Machariel');
});

test('splits destroyed and dropped items', () => {
  const km = parseKillmail(SAMPLE);
  const destroyed = km.items.filter((i) => i.status === 'destroyed');
  const dropped = km.items.filter((i) => i.status === 'dropped');
  assert.equal(destroyed.length, 30);
  assert.equal(dropped.length, 22);
});

test('parses quantity and cargo location on item lines', () => {
  assert.deepEqual(parseItemLine('Rocket Launcher II '), { name: 'Rocket Launcher II', qty: 1, location: null });
  assert.deepEqual(parseItemLine('Gyrostabilizer II, Qty: 4 (Cargo)'), { name: 'Gyrostabilizer II', qty: 4, location: 'Cargo' });
  assert.deepEqual(parseItemLine('Hecate (Cargo)'), { name: 'Hecate', qty: 1, location: 'Cargo' });
  assert.deepEqual(parseItemLine('Oxygen Isotopes, Qty: 100000 (Cargo)'), { name: 'Oxygen Isotopes', qty: 100000, location: 'Cargo' });
  assert.deepEqual(parseItemLine('Nanite Repair Paste, Qty: 1,658 (Cargo)'), { name: 'Nanite Repair Paste', qty: 1658, location: 'Cargo' });
});

test('an item named like a ship is not mistaken for a section', () => {
  const km = parseKillmail(SAMPLE);
  const dropped = km.items.filter((i) => i.status === 'dropped');
  assert.ok(dropped.some((i) => i.name === 'Hecate'));
});

test('the same killmail hashes identically and different ones do not', () => {
  const a = parseKillmail(SAMPLE);
  const b = parseKillmail(SAMPLE);
  assert.equal(a.hash, b.hash);

  const other = parseKillmail(SAMPLE.replace('Victim: DraconisBeta', 'Victim: DraconisAlpha'));
  assert.notEqual(a.hash, other.hash);
});

test('splits a paste containing several killmails', () => {
  const second = SAMPLE
    .replace('2026.06.27 15:33:15', '2026.06.28 09:01:02')
    .replace('Victim: DraconisBeta', 'Victim: DraconisGamma');
  const blocks = splitKillmails(`${SAMPLE}\n\n${second}`);
  assert.equal(blocks.length, 2);

  const parsed = blocks.map(parseKillmail);
  assert.deepEqual(parsed.map((k) => k.victim.name), ['DraconisBeta', 'DraconisGamma']);
  assert.notEqual(parsed[0].hash, parsed[1].hash);
});

test('handles a killmail with no items and no alliance', () => {
  const minimal = [
    '2026.01.02 03:04:05',
    '',
    'Victim: Lone Pilot',
    'Corp: Solo Corp',
    'Alliance: None',
    'Faction: Unknown',
    'Destroyed: Rifter',
    'System: Tama',
    'Security: -0.3',
    'Damage Taken: 412',
    '',
    'Involved parties:',
    '',
    'Name: Gate Camp Guy (laid the final blow)',
    'Security: -9.4',
    'Corp: Camp Co',
    'Alliance: None',
    'Faction: None',
    'Ship: Svipul',
    'Weapon: 280mm Howitzer Artillery II',
    'Damage Done: 412',
  ].join('\n');

  const km = parseKillmail(minimal);
  assert.equal(km.victim.alliance, null);
  assert.equal(km.victim.security, -0.3);
  assert.equal(km.items.length, 0);
  assert.equal(km.attackers.length, 1);
  assert.equal(km.finalBlow.name, 'Gate Camp Guy');
});

test('rejects text that is not a killmail', () => {
  assert.throws(() => parseKillmail('just some words'), /timestamp/i);
  assert.throws(() => parseKillmail('2026.01.02 03:04:05\n\nCorp: Nobody'), /Victim/i);
  assert.throws(() => parseKillmail('2026.01.02 03:04:05\n\nVictim: Someone'), /Destroyed/i);
});

test('parses CRLF pastes', () => {
  const km = parseKillmail(SAMPLE.replace(/\n/g, '\r\n'));
  assert.equal(km.victim.name, 'DraconisBeta');
  assert.equal(km.attackers.length, 5);
});
