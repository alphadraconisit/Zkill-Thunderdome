'use strict';

const crypto = require('crypto');

/**
 * Parser for the classic EVE "copy killmail" text format, e.g.
 *
 *   2026.06.27 15:33:15
 *
 *   Victim: DraconisBeta
 *   Corp: Goat Trading Institute
 *   Alliance: OnlyAlts.
 *   Faction: Unknown
 *   Destroyed: Crane
 *   System: Ahbazon
 *   Security: 0.4
 *   Damage Taken: 5787
 *
 *   Involved parties:
 *
 *   Name: EF Zeta
 *   ...
 *
 *   Destroyed items:
 *   ...
 *
 *   Dropped items:
 *   ...
 */

const DATE_LINE = /^(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s*$/;
const FINAL_BLOW = /\s*\(laid the final blow\)\s*$/i;

// Values EVE writes when a field is simply not applicable.
const EMPTY_VALUES = new Set(['none', 'unknown', '', '-', 'n/a']);

const SECTIONS = {
  'involved parties': 'attackers',
  'destroyed items': 'destroyed',
  'dropped items': 'dropped',
};

function cleanValue(value) {
  const trimmed = (value || '').trim();
  return EMPTY_VALUES.has(trimmed.toLowerCase()) ? null : trimmed;
}

function parseNumber(value) {
  if (value == null) return null;
  const cleaned = String(value).replace(/[\s,]/g, '');
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** "2026.06.27 15:33:15" is EVE time, which is UTC. */
function parseTimestamp(line) {
  const m = line.match(DATE_LINE);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseField(line) {
  const idx = line.indexOf(':');
  if (idx === -1) return null;
  return {
    key: line.slice(0, idx).trim().toLowerCase(),
    value: line.slice(idx + 1).trim(),
  };
}

/**
 * Item lines look like:
 *   Rocket Launcher II
 *   Gyrostabilizer II, Qty: 4 (Cargo)
 *   Hecate (Cargo)
 *   Nanite Repair Paste, Qty: 658 (Cargo)
 */
function parseItemLine(line) {
  let rest = line.trim();
  if (!rest) return null;

  let location = null;
  const locMatch = rest.match(/\(([^()]+)\)\s*$/);
  if (locMatch) {
    location = locMatch[1].trim();
    rest = rest.slice(0, locMatch.index).trim();
  }

  let qty = 1;
  const qtyMatch = rest.match(/,\s*Qty:\s*([\d.,]+)\s*$/i);
  if (qtyMatch) {
    qty = parseNumber(qtyMatch[1]) ?? 1;
    rest = rest.slice(0, qtyMatch.index).trim();
  }

  const name = rest.replace(/,\s*$/, '').trim();
  if (!name) return null;
  return { name, qty: Math.round(qty), location };
}

/**
 * Splits a blob that may contain several pasted killmails into individual ones.
 * A new killmail starts at a bare timestamp line.
 */
function splitKillmails(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let current = null;

  for (const line of lines) {
    if (DATE_LINE.test(line)) {
      if (current && current.some((l) => l.trim())) blocks.push(current);
      current = [line];
      continue;
    }
    if (current) current.push(line);
  }
  if (current && current.some((l) => l.trim())) blocks.push(current);

  return blocks.map((b) => b.join('\n').trim()).filter(Boolean);
}

function parseKillmail(text) {
  const raw = String(text).replace(/\r\n?/g, '\n').trim();
  if (!raw) throw new Error('Killmail is empty.');

  const lines = raw.split('\n');
  const km = {
    killedAt: null,
    victim: {
      name: null, corp: null, alliance: null, faction: null,
      ship: null, system: null, security: null, damageTaken: null,
    },
    attackers: [],
    items: [],
    raw,
  };

  let section = 'header';
  let attacker = null;

  const pushAttacker = () => {
    if (attacker && attacker.name) km.attackers.push(attacker);
    attacker = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (!km.killedAt) {
      const ts = parseTimestamp(trimmed);
      if (ts) {
        km.killedAt = ts;
        continue;
      }
    }

    if (!trimmed) continue;

    // Section headers ("Involved parties:", "Destroyed items:", ...)
    const bare = trimmed.replace(/:\s*$/, '').toLowerCase();
    if (trimmed.endsWith(':') && SECTIONS[bare]) {
      pushAttacker();
      section = SECTIONS[bare];
      continue;
    }

    if (section === 'destroyed' || section === 'dropped') {
      const item = parseItemLine(trimmed);
      if (item) km.items.push({ ...item, status: section });
      continue;
    }

    const field = parseField(trimmed);

    if (section === 'header') {
      if (!field) continue;
      switch (field.key) {
        case 'victim': km.victim.name = cleanValue(field.value); break;
        case 'corp': km.victim.corp = cleanValue(field.value); break;
        case 'alliance': km.victim.alliance = cleanValue(field.value); break;
        case 'faction': km.victim.faction = cleanValue(field.value); break;
        case 'destroyed': km.victim.ship = cleanValue(field.value); break;
        case 'ship': if (!km.victim.ship) km.victim.ship = cleanValue(field.value); break;
        case 'system': km.victim.system = cleanValue(field.value); break;
        case 'security': km.victim.security = parseNumber(field.value); break;
        case 'damage taken': km.victim.damageTaken = parseNumber(field.value); break;
        default: break;
      }
      continue;
    }

    if (section === 'attackers') {
      if (!field) continue;
      if (field.key === 'name') {
        pushAttacker();
        const finalBlow = FINAL_BLOW.test(field.value);
        attacker = {
          name: cleanValue(field.value.replace(FINAL_BLOW, '')),
          security: null, corp: null, alliance: null, faction: null,
          ship: null, weapon: null, damage: 0, finalBlow,
        };
        continue;
      }
      if (!attacker) continue;
      switch (field.key) {
        case 'security': attacker.security = parseNumber(field.value); break;
        case 'corp': attacker.corp = cleanValue(field.value); break;
        case 'alliance': attacker.alliance = cleanValue(field.value); break;
        case 'faction': attacker.faction = cleanValue(field.value); break;
        case 'ship': attacker.ship = cleanValue(field.value); break;
        case 'weapon': attacker.weapon = cleanValue(field.value); break;
        case 'damage done': attacker.damage = parseNumber(field.value) ?? 0; break;
        default: break;
      }
    }
  }

  pushAttacker();

  if (!km.killedAt) throw new Error('No timestamp found (expected a "YYYY.MM.DD HH:MM:SS" line).');
  if (!km.victim.name) throw new Error('No "Victim:" line found.');
  if (!km.victim.ship) throw new Error('No "Destroyed:" line found (victim ship).');

  // Attackers land in paste order; damage order is what a killboard shows.
  km.attackers.sort((a, b) => (b.damage || 0) - (a.damage || 0));

  km.totalDamage = km.attackers.reduce((sum, a) => sum + (a.damage || 0), 0);
  km.finalBlow = km.attackers.find((a) => a.finalBlow) || null;
  km.hash = killmailHash(km);
  return km;
}

/**
 * Stable identity for a killmail so the same paste twice is not two kills.
 * Deliberately ignores item lists (cargo scan noise) and attacker ordering.
 */
function killmailHash(km) {
  const parts = [
    km.killedAt,
    (km.victim.name || '').toLowerCase(),
    (km.victim.ship || '').toLowerCase(),
    (km.victim.system || '').toLowerCase(),
    String(km.victim.damageTaken ?? ''),
    km.attackers.map((a) => (a.name || '').toLowerCase()).sort().join('|'),
  ];
  return crypto.createHash('sha256').update(parts.join('::')).digest('hex').slice(0, 32);
}

module.exports = { parseKillmail, splitKillmails, parseItemLine, parseTimestamp, killmailHash };
