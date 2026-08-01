'use strict';

/**
 * Battle report aggregation.
 *
 * A "battle" is just every killmail inside a time window (optionally one
 * system). The work is turning that pile of mails into sides.
 *
 * Sides are inferred from who shoots alongside whom: two entities that appear
 * on the same killmail's attacker list are on the same side, and that relation
 * is closed transitively. Victims are not merged with their killers, so a fleet
 * that only died still shows up as its own side.
 *
 * An "entity" is an alliance, or a corporation when there is no alliance, or a
 * lone pilot when there is neither — the same fallback a killboard uses when it
 * has to pick one label for a pilot.
 */

const MAX_CHART_SERIES = 6;

class DisjointSet {
  constructor() {
    this.parent = new Map();
  }

  add(key) {
    if (!this.parent.has(key)) this.parent.set(key, key);
    return key;
  }

  find(key) {
    let root = key;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    // Path compression, so long alliance chains stay cheap.
    let cursor = key;
    while (this.parent.get(cursor) !== root) {
      const next = this.parent.get(cursor);
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  union(a, b) {
    const rootA = this.find(this.add(a));
    const rootB = this.find(this.add(b));
    if (rootA !== rootB) this.parent.set(rootB, rootA);
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
    entityKey: null,
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
 * @param {Array} kills   killmail rows for the window
 * @param {Array} attackers attacker rows for those killmails (with killmail_id)
 */
function analyseBattle(kills, attackers) {
  const byKill = new Map();
  for (const a of attackers) {
    if (!byKill.has(a.killmail_id)) byKill.set(a.killmail_id, []);
    byKill.get(a.killmail_id).push(a);
  }

  const dsu = new DisjointSet();
  const entities = new Map(); // key -> { label, kind, pilots:Set }
  const pilots = new Map();
  const pilotEntityVotes = new Map(); // pilot -> Map(entityKey -> count)

  const noteEntity = (entity) => {
    dsu.add(entity.key);
    if (!entities.has(entity.key)) {
      entities.set(entity.key, { ...entity, pilots: new Set() });
    }
    return entity.key;
  };

  const votePilotEntity = (name, entityKey) => {
    const key = pilotKey(name);
    if (!pilotEntityVotes.has(key)) pilotEntityVotes.set(key, new Map());
    const votes = pilotEntityVotes.get(key);
    votes.set(entityKey, (votes.get(entityKey) || 0) + 1);
  };

  const pilotFor = (name) => {
    const key = pilotKey(name);
    if (!pilots.has(key)) pilots.set(key, emptyPilot(name));
    return pilots.get(key);
  };

  // Pass 1: register everyone, and merge co-attackers into shared sides.
  for (const k of kills) {
    const victimEntity = entityOf(k.victim_alliance, k.victim_corp, k.victim_name);
    noteEntity(victimEntity);
    votePilotEntity(k.victim_name, victimEntity.key);

    const rows = byKill.get(k.id) || [];
    const attackerKeys = [];
    for (const a of rows) {
      const entity = entityOf(a.alliance, a.corp, a.name);
      noteEntity(entity);
      votePilotEntity(a.name, entity.key);
      attackerKeys.push(entity.key);
    }

    for (let i = 1; i < attackerKeys.length; i++) {
      dsu.union(attackerKeys[0], attackerKeys[i]);
    }
  }

  // Each pilot lands on the entity they appeared under most often.
  const entityForPilot = new Map();
  for (const [key, votes] of pilotEntityVotes) {
    let best = null;
    let bestCount = -1;
    for (const [entityKey, count] of votes) {
      if (count > bestCount) { best = entityKey; bestCount = count; }
    }
    entityForPilot.set(key, best);
    entities.get(best).pilots.add(key);
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
    pilot.entityKey = entityForPilot.get(key) || null;
  }

  // Group entities into teams by their disjoint-set root.
  const teamsByRoot = new Map();
  for (const [key, entity] of entities) {
    const root = dsu.find(key);
    if (!teamsByRoot.has(root)) teamsByRoot.set(root, { root, entities: [], pilots: [] });
    teamsByRoot.get(root).entities.push(entity);
  }

  for (const [key, pilot] of pilots) {
    const entityKey = entityForPilot.get(key);
    if (!entityKey) continue;
    teamsByRoot.get(dsu.find(entityKey)).pilots.push(pilot);
  }

  const teamOfPilot = (name) => {
    const entityKey = entityForPilot.get(pilotKey(name));
    return entityKey ? dsu.find(entityKey) : null;
  };

  // Kills and losses are only meaningful once every pilot has a team.
  for (const team of teamsByRoot.values()) {
    team.kills = 0;
    team.losses = 0;
    team.damageDone = 0;
    team.damageTaken = 0;
  }

  for (const k of kills) {
    const victimTeam = teamOfPilot(k.victim_name);
    if (victimTeam && teamsByRoot.has(victimTeam)) {
      teamsByRoot.get(victimTeam).losses += 1;
    }

    const creditedTeams = new Set();
    for (const a of byKill.get(k.id) || []) {
      const team = teamOfPilot(a.name);
      if (team && team !== victimTeam) creditedTeams.add(team);
    }
    for (const team of creditedTeams) {
      if (teamsByRoot.has(team)) teamsByRoot.get(team).kills += 1;
    }
  }

  for (const team of teamsByRoot.values()) {
    for (const pilot of team.pilots) {
      team.damageDone += pilot.damageDone;
      team.damageTaken += pilot.damageTaken;
    }
    team.pilots.sort((a, b) => b.damageDone - a.damageDone || a.name.localeCompare(b.name));

    // Name the side after its biggest entity, noting how many others joined it.
    team.entities.sort((a, b) => b.pilots.size - a.pilots.size || a.label.localeCompare(b.label));
    team.label = team.entities[0] ? team.entities[0].label : 'Unknown';
    team.kind = team.entities[0] ? team.entities[0].kind : 'character';
    team.alliedCount = team.entities.length - 1;
    team.pilotCount = team.pilots.length;
  }

  const teams = [...teamsByRoot.values()]
    .filter((t) => t.pilotCount > 0)
    .sort((a, b) => b.damageDone - a.damageDone || b.pilotCount - a.pilotCount);

  const totalDamage = teams.reduce((sum, t) => sum + t.damageDone, 0);
  for (const team of teams) {
    team.damageShare = totalDamage ? Math.round((team.damageDone / totalDamage) * 1000) / 10 : 0;
    for (const pilot of team.pilots) pilot.shipList = [...pilot.ships];
  }

  return {
    teams,
    timeline: buildTimeline(kills, byKill, teams, teamOfPilot),
    summary: summarise(kills, teams, totalDamage),
  };
}

/** Cumulative damage per team at each killmail, for the timeline chart. */
function buildTimeline(kills, byKill, teams, teamOfPilot) {
  const ordered = [...kills].sort((a, b) => a.killed_at.localeCompare(b.killed_at));
  if (!ordered.length) return { series: [], events: [] };

  const running = new Map(teams.map((t) => [t.root, 0]));
  const series = new Map(teams.map((t) => [t.root, []]));

  const start = new Date(ordered[0].killed_at).getTime();
  for (const team of teams) series.get(team.root).push({ t: start, v: 0 });

  const events = [];
  for (const k of ordered) {
    const at = new Date(k.killed_at).getTime();

    for (const a of byKill.get(k.id) || []) {
      const team = teamOfPilot(a.name);
      if (team != null && running.has(team)) {
        running.set(team, running.get(team) + (a.damage || 0));
      }
    }

    for (const team of teams) series.get(team.root).push({ t: at, v: running.get(team.root) });
    events.push({ t: at, id: k.id, victim: k.victim_name, ship: k.ship });
  }

  return {
    series: teams.map((team) => ({
      root: team.root,
      label: team.label,
      points: series.get(team.root),
      total: running.get(team.root),
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

module.exports = { analyseBattle, entityOf, formatDuration, MAX_CHART_SERIES };
