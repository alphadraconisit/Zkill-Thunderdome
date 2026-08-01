'use strict';

const { entityOf } = require('./battle');

/**
 * Battle detection.
 *
 * A battle is a run of killmails in one system that are *related*. A mail joins
 * a battle when all three hold:
 *
 *   1. it happens within `gapMinutes` of that battle's latest kill;
 *   2. it shares at least one participating pilot, corp or alliance with it;
 *   3. the victim has not already lost a ship in it.
 *
 * Rule 2 separates a fight from an unrelated gank in the same system minutes
 * later. Rule 3 is the sharp one: a pilot only has one ship to lose, so a
 * second loss means they re-shipped and returned, which makes it a new battle
 * however close the clock says it was. Pods are exempt — a capsule dies right
 * after the ship that was carrying it, in the same fight.
 *
 * This is single-link clustering over (system, time, participants), with rule 3
 * as a hard boundary. It is deterministic — the same killmails always produce
 * the same battles — and runs in a single pass per system.
 *
 * A mail that bridges two open battles merges them, which is what happens when
 * two skirmishes converge into one fight, unless merging would give some pilot
 * two ship losses.
 */

const DEFAULTS = {
  gapMinutes: 20,      // longest quiet stretch that still counts as the same fight
  minKills: 2,         // a lone killmail is a gank, not a battle
  lullFloorMinutes: 8, // never tighten the gap below this
  // A lull this many times the battle's own rhythm ends it. Battles run 10-20
  // minutes, so a silence of three times the normal spacing between kills is
  // already most of a fight's length and means the field cleared.
  lullFactor: 3,
};

function timeOf(kill) {
  return new Date(kill.killed_at).getTime();
}

/**
 * A pod loss follows the ship loss that made it, so it does not count as a
 * second ship for the one-loss-per-pilot rule below.
 */
function isPod(kill) {
  return /^capsule\b/i.test(kill.ship || '');
}

function victimKey(kill) {
  return (kill.victim_name || '').toLowerCase();
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * How long this battle may stay quiet before the next kill counts as a new one.
 *
 * A flat gap reads a brawl trading kills every ninety seconds the same as a slow
 * grind, so a four-minute lull in the brawl — obviously the end of it — keeps the
 * battle open and the next fight's opening kill gets absorbed into it. The gap is
 * therefore scaled to the battle's own rhythm.
 *
 * This can only ever *tighten* the configured gap, never extend it, so it splits
 * more finely and never merges battles that were previously separate.
 */
function effectiveGapMs(cluster, hardGapMs, lullFloorMs, lullFactor) {
  if (!lullFactor) return hardGapMs; // adaptive tightening switched off
  const rhythm = median(cluster.gaps);
  if (rhythm == null) return hardGapMs; // a single kill has no rhythm yet
  return Math.min(hardGapMs, Math.max(lullFloorMs, rhythm * lullFactor));
}

/**
 * A pilot can only lose one ship per battle — to lose a second they had to
 * re-ship, which means the first fight was over. So a repeat ship loss by the
 * same pilot marks a battle boundary, whatever the clock says.
 */
function canAcceptVictim(cluster, kill) {
  if (isPod(kill)) return true;
  return !cluster.shipLosses.has(victimKey(kill));
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
  const cluster = {
    system: kill.system,
    kills: [],
    entities: new Set(),
    pilots: new Set(),
    shipLosses: new Set(),
    gaps: [],
    start: timeOf(kill),
    end: timeOf(kill),
  };
  absorb(cluster, kill, participants);
  return cluster;
}

function absorb(cluster, kill, participants) {
  const at = timeOf(kill);
  // Only forward steps describe the battle's pace; a pod landing on the same
  // second as its ship is not a one-second rhythm.
  if (cluster.kills.length && at > cluster.end) cluster.gaps.push(at - cluster.end);

  cluster.kills.push(kill);
  for (const e of participants.entities) cluster.entities.add(e);
  for (const p of participants.pilots) cluster.pilots.add(p);
  if (!isPod(kill)) cluster.shipLosses.add(victimKey(kill));
  cluster.end = Math.max(cluster.end, at);
  cluster.start = Math.min(cluster.start, at);
}

function mergeInto(target, other) {
  target.kills.push(...other.kills);
  for (const e of other.entities) target.entities.add(e);
  for (const p of other.pilots) target.pilots.add(p);
  for (const v of other.shipLosses) target.shipLosses.add(v);
  target.gaps.push(...other.gaps);
  target.start = Math.min(target.start, other.start);
  target.end = Math.max(target.end, other.end);
}

/**
 * @param {Array} kills     killmail rows, any order
 * @param {Array} attackers attacker rows for those killmails
 * @returns {Array} battles, most recent first
 */
function detectBattles(kills, attackers, options = {}) {
  const { gapMinutes, minKills, lullFloorMinutes, lullFactor } = { ...DEFAULTS, ...options };
  const gapMs = Math.max(1, gapMinutes) * 60000;
  const lullFloorMs = Math.max(0, lullFloorMinutes) * 60000;

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

      // Anything quiet for longer than its own gap can never be rejoined —
      // later kills are only further away in time.
      const stillOpen = [];
      for (const cluster of open) {
        if (at - cluster.end > effectiveGapMs(cluster, gapMs, lullFloorMs, lullFactor)) {
          finished.push(cluster);
        } else {
          stillOpen.push(cluster);
        }
      }
      open = stillOpen;

      const related = open.filter((cluster) => intersects(cluster.entities, participants.entities));

      // This pilot already lost a ship in these battles, so they re-shipped and
      // those battles have ended. Retire them rather than let later kills
      // stitch the old fight back onto the new one.
      const ended = related.filter((cluster) => !canAcceptVictim(cluster, kill));
      if (ended.length) {
        finished.push(...ended);
        open = open.filter((cluster) => !ended.includes(cluster));
      }

      const matches = related.filter((cluster) => !ended.includes(cluster));

      if (matches.length === 0) {
        open.push(newCluster(kill, participants));
        continue;
      }

      // This kill ties the matching clusters together into one battle, but only
      // those that can merge without giving a pilot two ship losses. The kill
      // joins whichever battle was most recently active, not whichever opened
      // first.
      const ordered = [...matches].sort((a, b) => b.end - a.end);
      const [primary, ...candidates] = ordered;
      absorb(primary, kill, participants);

      const merged = [];
      for (const other of candidates) {
        if (intersects(primary.shipLosses, other.shipLosses)) continue;
        mergeInto(primary, other);
        merged.push(other);
      }
      if (merged.length) open = open.filter((c) => !merged.includes(c));
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
    killIds: kills.map((k) => k.id),
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

/** The detected battle a given killmail belongs to, or null. */
function findBattleContaining(kills, attackers, killId, options = {}) {
  const battles = detectBattles(kills, attackers, { ...options, minKills: 1 });
  return battles.find((battle) => battle.killIds.includes(killId)) || null;
}

module.exports = { detectBattles, findBattleContaining, isPod, DEFAULTS };
