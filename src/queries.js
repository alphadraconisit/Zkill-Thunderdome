'use strict';

const { db } = require('./db');

const PAGE_SIZE = 25;

/**
 * Cut-off for a trailing window, in the same ISO format killed_at is stored in.
 * SQLite's own datetime() renders "YYYY-MM-DD HH:MM:SS", which does not compare
 * correctly against ISO strings on the boundary day.
 */
function sinceIso(days) {
  return new Date(Date.now() - Math.max(1, days) * 86400000).toISOString();
}

const KILL_COLUMNS = `
  k.id, k.hash, k.killed_at, k.victim_name, k.victim_corp, k.victim_alliance,
  k.ship, k.system, k.security, k.damage_taken, k.attacker_count, k.final_blow
`;

/**
 * Builds the WHERE clause for an entity view.
 *
 * `side` is 'losses' (the entity is the victim), 'kills' (the entity is on the
 * attacking side) or 'all'. Systems and ships have no sides — a system filter
 * matches where the fight happened, and a ship filter matches either side.
 */
function entityClause(kind, name, side) {
  const p = { name };

  const victim = {
    character: 'k.victim_name = @name COLLATE NOCASE',
    corporation: 'k.victim_corp = @name COLLATE NOCASE',
    alliance: 'k.victim_alliance = @name COLLATE NOCASE',
    ship: 'k.ship = @name COLLATE NOCASE',
  }[kind];

  const attackerColumn = {
    character: 'a.name',
    corporation: 'a.corp',
    alliance: 'a.alliance',
    ship: 'a.ship',
  }[kind];

  const attacker = attackerColumn
    ? `EXISTS (SELECT 1 FROM attackers a WHERE a.killmail_id = k.id AND ${attackerColumn} = @name COLLATE NOCASE)`
    : null;

  if (kind === 'system') return { where: 'k.system = @name COLLATE NOCASE', params: p };
  if (!victim) throw new Error(`Unknown entity kind: ${kind}`);

  if (side === 'losses') return { where: victim, params: p };
  if (side === 'kills') return { where: `${attacker} AND NOT (${victim})`, params: p };
  return { where: `(${victim} OR ${attacker})`, params: p };
}

function listKills({ where = '1=1', params = {}, page = 1, pageSize = PAGE_SIZE } = {}) {
  const offset = (Math.max(1, page) - 1) * pageSize;
  const rows = db.prepare(`
    SELECT ${KILL_COLUMNS} FROM killmails k
    WHERE ${where}
    ORDER BY k.killed_at DESC, k.id DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: pageSize, offset });

  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM killmails k WHERE ${where}`).get(params);

  return { rows, total, page: Math.max(1, page), pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

function getKillmail(id) {
  const kill = db.prepare('SELECT * FROM killmails WHERE id = ?').get(id);
  if (!kill) return null;

  kill.attackers = db.prepare(
    'SELECT * FROM attackers WHERE killmail_id = ? ORDER BY damage DESC, position ASC'
  ).all(id);

  const items = db.prepare(
    'SELECT * FROM items WHERE killmail_id = ? ORDER BY location IS NULL DESC, location ASC, name ASC'
  ).all(id);

  kill.destroyedItems = items.filter((i) => i.status === 'destroyed');
  kill.droppedItems = items.filter((i) => i.status === 'dropped');
  return kill;
}

function entityStats(kind, name) {
  const losses = entityClause(kind, name, 'losses');
  const kills = entityClause(kind, name, 'kills');

  const count = (clause) =>
    db.prepare(`SELECT COUNT(*) AS n FROM killmails k WHERE ${clause.where}`).get(clause.params).n;

  if (kind === 'system') {
    const all = entityClause(kind, name, 'all');
    return { kills: count(all), losses: 0, total: count(all), efficiency: null };
  }

  const k = count(kills);
  const l = count(losses);
  return {
    kills: k,
    losses: l,
    total: k + l,
    efficiency: k + l === 0 ? null : Math.round((k / (k + l)) * 1000) / 10,
  };
}

/** Top involved entities on an entity's kills — the "who they fly with" panel. */
function topAssociates(kind, name, column, limit = 10) {
  const clause = entityClause(kind, name, 'kills');
  return db.prepare(`
    SELECT a.${column} AS label, COUNT(DISTINCT a.killmail_id) AS n
    FROM attackers a
    WHERE a.killmail_id IN (SELECT k.id FROM killmails k WHERE ${clause.where})
      AND a.${column} IS NOT NULL
    GROUP BY a.${column} COLLATE NOCASE
    ORDER BY n DESC, label ASC
    LIMIT @limit
  `).all({ ...clause.params, limit });
}

function shipBreakdown(kind, name, limit = 10) {
  const clause = entityClause(kind, name, 'losses');
  return db.prepare(`
    SELECT k.ship AS label, COUNT(*) AS n
    FROM killmails k
    WHERE ${clause.where}
    GROUP BY k.ship COLLATE NOCASE
    ORDER BY n DESC, label ASC
    LIMIT @limit
  `).all({ ...clause.params, limit });
}

function boardSummary() {
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS killmails,
      COALESCE(SUM(attacker_count), 0) AS involved,
      MIN(killed_at) AS first_kill,
      MAX(killed_at) AS last_kill
    FROM killmails
  `).get();

  const pilots = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT victim_name AS name FROM killmails
      UNION
      SELECT name FROM attackers
    )
  `).get().n;

  const last7 = db.prepare('SELECT COUNT(*) AS n FROM killmails WHERE killed_at >= ?')
    .get(sinceIso(7)).n;

  return { ...totals, pilots, last7 };
}

function killsSince(days) {
  return db.prepare('SELECT COUNT(*) AS n FROM killmails WHERE killed_at >= ?')
    .get(sinceIso(days)).n;
}

/**
 * Leaderboards for the front page. `days` of null means all time — a quiet
 * private board should not show five empty panels just because nobody
 * undocked this month.
 */
function leaderboard(column, { days = 30, limit = 10 } = {}) {
  const windowed = days != null;
  return db.prepare(`
    SELECT a.${column} AS label, COUNT(DISTINCT a.killmail_id) AS n
    FROM attackers a
    JOIN killmails k ON k.id = a.killmail_id
    WHERE a.${column} IS NOT NULL
      ${windowed ? 'AND k.killed_at >= @since' : ''}
    GROUP BY a.${column} COLLATE NOCASE
    ORDER BY n DESC, label ASC
    LIMIT @limit
  `).all(windowed ? { since: sinceIso(days), limit } : { limit });
}

function topSystems({ days = 30, limit = 10 } = {}) {
  const windowed = days != null;
  return db.prepare(`
    SELECT system AS label, COUNT(*) AS n
    FROM killmails
    WHERE system IS NOT NULL
      ${windowed ? 'AND killed_at >= @since' : ''}
    GROUP BY system COLLATE NOCASE
    ORDER BY n DESC, label ASC
    LIMIT @limit
  `).all(windowed ? { since: sinceIso(days), limit } : { limit });
}

/** Kills per day for the activity sparkline. */
function activity(days = 30) {
  const rows = db.prepare(`
    SELECT date(killed_at) AS day, COUNT(*) AS n
    FROM killmails
    WHERE killed_at >= @since
    GROUP BY day
  `).all({ since: sinceIso(days - 1).slice(0, 10) });

  const byDay = new Map(rows.map((r) => [r.day, r.n]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    out.push({ day: d, n: byDay.get(d) || 0 });
  }
  return out;
}

/** Cross-entity search over pilots, corps, alliances, systems and ships. */
function search(term, limit = 40) {
  const like = `%${term}%`;
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT 'character'   AS kind, victim_name     AS label FROM killmails WHERE victim_name     LIKE @like
      UNION SELECT 'character',     name                     FROM attackers WHERE name            LIKE @like
      UNION SELECT 'corporation',   victim_corp              FROM killmails WHERE victim_corp     LIKE @like
      UNION SELECT 'corporation',   corp                     FROM attackers WHERE corp            LIKE @like
      UNION SELECT 'alliance',      victim_alliance          FROM killmails WHERE victim_alliance LIKE @like
      UNION SELECT 'alliance',      alliance                 FROM attackers WHERE alliance        LIKE @like
      UNION SELECT 'system',        system                   FROM killmails WHERE system          LIKE @like
      UNION SELECT 'ship',          ship                     FROM killmails WHERE ship            LIKE @like
      UNION SELECT 'ship',          ship                     FROM attackers WHERE ship            LIKE @like
    )
    WHERE label IS NOT NULL
    ORDER BY length(label) ASC, label ASC
    LIMIT @limit
  `).all({ like, limit });

  // The UNION is case-sensitive; fold near-duplicate spellings for display.
  const seen = new Set();
  return rows.filter((r) => {
    const key = `${r.kind}:${r.label.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function distinctShipNames() {
  return db.prepare(`
    SELECT DISTINCT name FROM (
      SELECT ship AS name FROM killmails WHERE ship IS NOT NULL
      UNION SELECT ship FROM attackers WHERE ship IS NOT NULL
    )
  `).all().map((r) => r.name);
}

module.exports = {
  PAGE_SIZE,
  entityClause,
  listKills,
  getKillmail,
  entityStats,
  topAssociates,
  shipBreakdown,
  boardSummary,
  killsSince,
  leaderboard,
  topSystems,
  activity,
  search,
  distinctShipNames,
};
