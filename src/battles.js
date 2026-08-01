'use strict';

const { entityOf } = require('./battle');

/**
 * Battle detection.
 *
 * A battle is a run of killmails in one system that are *related*: each mail
 * joins a battle when it happens within `gapMinutes` of that battle's latest
 * kill and shares at least one participating entity with it. Sharing is what
 * separates one fight from an unrelated gank happening in the same system ten
 * minutes later.
 *
 * This is single-link clustering over (system, time, participants). It is
 * deterministic — the same killmails always produce the same battles — and
 * runs in a single pass per system.
 *
 * A mail that bridges two open battles merges them, which is what happens when
 * two skirmishes converge into one fight.
 */

const DEFAULTS = {
  gapMinutes: 20, // longest quiet stretch that still counts as the same fight
  minKills: 2,    // a lone killmail is a gank, not a battle
};

function timeOf(kill) {
  return new Date(kill.killed_at).getTime();
}

/** Entities and pilots on a killmail, both sides included. */
function participantsOf(kill, attackerRows) {
  const entities = new Set();
  const pilots = new Set();

  const victim = entityOf(kill.victim_alliance, kill.victim_corp, kill.victim_name);
  entities.add(victim.key);
  pilots.add((kill.victim_name || '').toLowerCase());

  for (const a of attackerRows) {
    entities.add(entityOf(a.alliance, a.corp, a.name).key);
    pilots.add((a.name || '').toLowerCase());
  }

  return { entities, pilots };
}

function intersects(a, b) {
  // Walk the smaller set — participant lists can be very lopsided.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const value of small) if (large.has(value)) return true;
  return false;
}

function newCluster(kill, participants) {
  return {
    system: kill.system,
    kills: [kill],
    entities: new Set(participants.entities),
    pilots: new Set(participants.pilots),
    start: timeOf(kill),
    end: timeOf(kill),
  };
}

function absorb(cluster, kill, participants) {
  cluster.kills.push(kill);
  for (const e of participants.entities) cluster.entities.add(e);
  for (const p of participants.pilots) cluster.pilots.add(p);
  cluster.end = Math.max(cluster.end, timeOf(kill));
  cluster.start = Math.min(cluster.start, timeOf(kill));
}

function mergeInto(target, other) {
  target.kills.push(...other.kills);
  for (const e of other.entities) target.entities.add(e);
  for (const p of other.pilots) target.pilots.add(p);
  target.start = Math.min(target.start, other.start);
  target.end = Math.max(target.end, other.end);
}

/**
 * @param {Array} kills     killmail rows, any order
 * @param {Array} attackers attacker rows for those killmails
 * @returns {Array} battles, most recent first
 */
function detectBattles(kills, attackers, options = {}) {
  const { gapMinutes, minKills } = { ...DEFAULTS, ...options };
  const gapMs = Math.max(1, gapMinutes) * 60000;

  const byKill = new Map();
  for (const a of attackers) {
    if (!byKill.has(a.killmail_id)) byKill.set(a.killmail_id, []);
    byKill.get(a.killmail_id).push(a);
  }

  // Battles do not span systems, so each system clusters independently.
  const bySystem = new Map();
  for (const kill of kills) {
    const key = kill.system || '(unknown)';
    if (!bySystem.has(key)) bySystem.set(key, []);
    bySystem.get(key).push(kill);
  }

  const finished = [];

  for (const systemKills of bySystem.values()) {
    systemKills.sort((a, b) => timeOf(a) - timeOf(b) || a.id - b.id);

    let open = [];

    for (const kill of systemKills) {
      const at = timeOf(kill);
      const participants = participantsOf(kill, byKill.get(kill.id) || []);

      // Anything that has been quiet for longer than the gap can never be
      // rejoined — later kills are only further away in time.
      const stillOpen = [];
      for (const cluster of open) {
        if (at - cluster.end > gapMs) finished.push(cluster);
        else stillOpen.push(cluster);
      }
      open = stillOpen;

      const matches = open.filter((cluster) => intersects(cluster.entities, participants.entities));

      if (matches.length === 0) {
        open.push(newCluster(kill, participants));
        continue;
      }

      // This kill ties every matching cluster together into one battle.
      const [primary, ...rest] = matches;
      absorb(primary, kill, participants);
      for (const other of rest) mergeInto(primary, other);
      if (rest.length) open = open.filter((c) => c === primary || !rest.includes(c));
    }

    finished.push(...open);
  }

  return finished
    .filter((cluster) => cluster.kills.length >= minKills)
    .map((cluster) => summariseBattle(cluster, byKill))
    .sort((a, b) => b.startMs - a.startMs);
}

/** Enough detail to render a battle card without re-running the full report. */
function summariseBattle(cluster, byKill) {
  const damageByEntity = new Map();
  let totalDamage = 0;

  for (const kill of cluster.kills) {
    for (const a of byKill.get(kill.id) || []) {
      const entity = entityOf(a.alliance, a.corp, a.name);
      const damage = a.damage || 0;
      totalDamage += damage;

      const current = damageByEntity.get(entity.key);
      if (current) current.damage += damage;
      else damageByEntity.set(entity.key, { label: entity.label, kind: entity.kind, damage });
    }
  }

  const sides = [...damageByEntity.values()].sort((a, b) => b.damage - a.damage);
  const kills = [...cluster.kills].sort((a, b) => timeOf(a) - timeOf(b));

  return {
    system: cluster.system,
    startMs: cluster.start,
    endMs: cluster.end,
    start: new Date(cluster.start).toISOString(),
    end: new Date(cluster.end).toISOString(),
    durationMs: cluster.end - cluster.start,
    killCount: cluster.kills.length,
    pilotCount: cluster.pilots.size,
    sideCount: sides.length,
    damage: totalDamage,
    sides: sides.slice(0, 3),
    topKill: kills.reduce((best, k) => ((k.damage_taken || 0) > (best.damage_taken || 0) ? k : best), kills[0]),
    firstKillId: kills[0].id,
  };
}

module.exports = { detectBattles, DEFAULTS };
