'use strict';

/**
 * Battle report aggregation.
 *
 * A "battle" is just every killmail inside a time window (optionally one
 * system). Sides are one per alliance: every pilot flying under the same
 * alliance banner is one side, and no two alliances are ever merged.
 *
 * Pilots with no alliance fall back to their corporation, and pilots with
 * neither stand alone — the same fallback a killboard uses when it has to pick
 * one label for a pilot.
 */

class Side {
  constructor(entity) {
    this.key = entity.key;
    this.label = entity.label;
    this.kind = entity.kind;
    this.pilots = [];
    this.corporations = new Set();
    this.kills = 0;
    this.losses = 0;
    this.damageDone = 0;
    this.damageTaken = 0;
  }
}

function entityOf(alliance, corp, name) {
  if (alliance) return { key: `alliance:${alliance.toLowerCase()}`, label: alliance, kind: 'alliance' };
  if (corp) return { key: `corporation:${corp.toLowerCase()}`, label: corp, kind: 'corporation' };
  return { key: `character:${(name || 'unknown').toLowerCase()}`, label: name || 'Unknown', kind: 'character' };
}

function pilotKey(name) {
  return (name || 'Unknown').toLowerCase();
}

function emptyPilot(name) {
  return {
    name,
    sideKey: null,
    corp: null,
    alliance: null,
    damageDone: 0,
    damageTaken: 0,
    kills: 0,
    shipsLost: 0,
    ships: new Set(),
  };
}

/**
 * @param {Array} kills     killmail rows for the window
 * @param {Array} attackers attacker rows for those killmails (with killmail_id)
 */
function analyseBattle(kills, attackers) {
  const byKill = new Map();
  for (const a of attackers) {
    if (!byKill.has(a.killmail_id)) byKill.set(a.killmail_id, []);
    byKill.get(a.killmail_id).push(a);
  }

  const sides = new Map();
  const pilots = new Map();
  const sideVotes = new Map(); // pilot -> Map(sideKey -> appearances)

  const noteSide = (entity) => {
    if (!sides.has(entity.key)) sides.set(entity.key, new Side(entity));
    return entity.key;
  };

  const voteSide = (name, sideKey, corp) => {
    const key = pilotKey(name);
    if (!sideVotes.has(key)) sideVotes.set(key, new Map());
    const votes = sideVotes.get(key);
    votes.set(sideKey, (votes.get(sideKey) || 0) + 1);
    if (corp) sides.get(sideKey).corporations.add(corp);
  };

  const pilotFor = (name) => {
    const key = pilotKey(name);
    if (!pilots.has(key)) pilots.set(key, emptyPilot(name));
    return pilots.get(key);
  };

  // Pass 1: every alliance that appears, on either side of a mail, is a side.
  for (const k of kills) {
    const victimSide = noteSide(entityOf(k.victim_alliance, k.victim_corp, k.victim_name));
    voteSide(k.victim_name, victimSide, k.victim_corp);

    for (const a of byKill.get(k.id) || []) {
      const attackerSide = noteSide(entityOf(a.alliance, a.corp, a.name));
      voteSide(a.name, attackerSide, a.corp);
    }
  }

  // A pilot belongs to the side they appeared under most often, so a single
  // mis-typed alliance on one mail does not split them in two.
  const sideForPilot = new Map();
  for (const [key, votes] of sideVotes) {
    let best = null;
    let bestCount = -1;
    for (const [sideKey, count] of votes) {
      if (count > bestCount) { best = sideKey; bestCount = count; }
    }
    sideForPilot.set(key, best);
  }

  // Pass 2: per-pilot damage, kills and losses.
  for (const k of kills) {
    const victim = pilotFor(k.victim_name);
    victim.damageTaken += k.damage_taken || 0;
    victim.shipsLost += 1;
    victim.ships.add(k.ship);
    victim.corp = victim.corp || k.victim_corp;
    victim.alliance = victim.alliance || k.victim_alliance;

    for (const a of byKill.get(k.id) || []) {
      const pilot = pilotFor(a.name);
      pilot.damageDone += a.damage || 0;
      pilot.kills += 1;
      if (a.ship) pilot.ships.add(a.ship);
      pilot.corp = pilot.corp || a.corp;
      pilot.alliance = pilot.alliance || a.alliance;
    }
  }

  for (const [key, pilot] of pilots) {
    pilot.sideKey = sideForPilot.get(key) || null;
    if (pilot.sideKey && sides.has(pilot.sideKey)) sides.get(pilot.sideKey).pilots.push(pilot);
  }

  const sideOfPilot = (name) => sideForPilot.get(pilotKey(name)) || null;

  // Pass 3: credit kills and losses to sides.
  for (const k of kills) {
    const victimSide = sideOfPilot(k.victim_name);
    if (victimSide && sides.has(victimSide)) sides.get(victimSide).losses += 1;

    const credited = new Set();
    for (const a of byKill.get(k.id) || []) {
      const side = sideOfPilot(a.name);
      if (side && side !== victimSide) credited.add(side);
    }
    for (const side of credited) sides.get(side).kills += 1;
  }

  for (const side of sides.values()) {
    for (const pilot of side.pilots) {
      side.damageDone += pilot.damageDone;
      side.damageTaken += pilot.damageTaken;
      pilot.shipList = [...pilot.ships];
    }
    side.pilots.sort((a, b) => b.damageDone - a.damageDone
      || b.damageTaken - a.damageTaken
      || a.name.localeCompare(b.name));
    side.pilotCount = side.pilots.length;
    side.corpCount = side.corporations.size;
    side.corpList = [...side.corporations].sort();
  }

  const teams = [...sides.values()]
    .filter((s) => s.pilotCount > 0)
    .sort((a, b) => b.damageDone - a.damageDone
      || b.pilotCount - a.pilotCount
      || a.label.localeCompare(b.label));

  const totalDamage = teams.reduce((sum, t) => sum + t.damageDone, 0);
  for (const team of teams) {
    team.damageShare = totalDamage ? Math.round((team.damageDone / totalDamage) * 1000) / 10 : 0;
  }

  return {
    teams,
    timeline: buildTimeline(kills, byKill, teams, sideOfPilot),
    summary: summarise(kills, teams, totalDamage),
  };
}

/** Cumulative damage per side at each killmail, for the timeline chart. */
function buildTimeline(kills, byKill, teams, sideOfPilot) {
  const ordered = [...kills].sort((a, b) => a.killed_at.localeCompare(b.killed_at));
  if (!ordered.length) return { series: [], events: [] };

  const running = new Map(teams.map((t) => [t.key, 0]));
  const series = new Map(teams.map((t) => [t.key, []]));

  const start = new Date(ordered[0].killed_at).getTime();
  for (const team of teams) series.get(team.key).push({ t: start, v: 0 });

  const events = [];
  for (const k of ordered) {
    const at = new Date(k.killed_at).getTime();

    for (const a of byKill.get(k.id) || []) {
      const side = sideOfPilot(a.name);
      if (side != null && running.has(side)) {
        running.set(side, running.get(side) + (a.damage || 0));
      }
    }

    for (const team of teams) series.get(team.key).push({ t: at, v: running.get(team.key) });
    events.push({ t: at, id: k.id, victim: k.victim_name, ship: k.ship });
  }

  return {
    series: teams.map((team) => ({
      key: team.key,
      label: team.label,
      points: series.get(team.key),
      total: running.get(team.key),
    })),
    events,
  };
}

function summarise(kills, teams, totalDamage) {
  if (!kills.length) {
    return { killmails: 0, pilots: 0, damage: 0, systems: [], start: null, end: null, durationMs: 0 };
  }

  const times = kills.map((k) => new Date(k.killed_at).getTime());
  const start = Math.min(...times);
  const end = Math.max(...times);
  const systems = [...new Set(kills.map((k) => k.system).filter(Boolean))].sort();

  return {
    killmails: kills.length,
    pilots: teams.reduce((sum, t) => sum + t.pilotCount, 0),
    damage: totalDamage,
    systems,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    durationMs: end - start,
  };
}

function formatDuration(ms) {
  if (!ms) return '0m';
  const minutes = Math.round(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

module.exports = { analyseBattle, entityOf, formatDuration };
