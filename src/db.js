'use strict';

const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

/**
 * Storage is libSQL, so the same code runs against a local file in development
 * and a hosted Turso database in production.
 *
 * TURSO_DATABASE_URL / TURSO_AUTH_TOKEN are what the Turso CLI hands you.
 * With neither set, the board falls back to a local file under DATA_DIR.
 */
function resolveConfig() {
  const url = process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL;
  if (url) {
    return { url, authToken: process.env.TURSO_AUTH_TOKEN || undefined };
  }

  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  return { url: `file:${path.join(dataDir, 'killboard.db')}` };
}

const config = resolveConfig();
const db = createClient(config);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS killmails (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  hash           TEXT NOT NULL UNIQUE,
  killed_at      TEXT NOT NULL,
  victim_name    TEXT NOT NULL,
  victim_corp    TEXT,
  victim_alliance TEXT,
  victim_faction TEXT,
  ship           TEXT NOT NULL,
  system         TEXT,
  security       REAL,
  damage_taken   INTEGER,
  total_damage   INTEGER,
  attacker_count INTEGER NOT NULL DEFAULT 0,
  final_blow     TEXT,
  raw            TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attackers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  killmail_id INTEGER NOT NULL REFERENCES killmails(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  name        TEXT NOT NULL,
  security    REAL,
  corp        TEXT,
  alliance    TEXT,
  faction     TEXT,
  ship        TEXT,
  weapon      TEXT,
  damage      INTEGER NOT NULL DEFAULT 0,
  final_blow  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  killmail_id INTEGER NOT NULL REFERENCES killmails(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  qty         INTEGER NOT NULL DEFAULT 1,
  location    TEXT,
  status      TEXT NOT NULL CHECK (status IN ('destroyed', 'dropped'))
);

CREATE TABLE IF NOT EXISTS type_ids (
  name        TEXT PRIMARY KEY,
  type_id     INTEGER,
  resolved_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_km_killed_at   ON killmails(killed_at DESC);
CREATE INDEX IF NOT EXISTS idx_km_victim      ON killmails(victim_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_km_victim_corp ON killmails(victim_corp COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_km_victim_alli ON killmails(victim_alliance COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_km_system      ON killmails(system COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_km_ship        ON killmails(ship COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_att_km         ON attackers(killmail_id);
CREATE INDEX IF NOT EXISTS idx_att_name       ON attackers(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_att_corp       ON attackers(corp COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_att_alli       ON attackers(alliance COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_att_ship       ON attackers(ship COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_items_km       ON items(killmail_id);
`;

async function migrate() {
  await db.executeMultiple(SCHEMA);
}

/** libSQL rows are array-like; hand plain objects to the rest of the app. */
function toObject(row) {
  if (!row) return null;
  const out = {};
  for (const key of Object.keys(row)) {
    if (!/^\d+$/.test(key) && key !== 'length') out[key] = row[key];
  }
  return out;
}

async function all(sql, args = {}) {
  const result = await db.execute({ sql, args });
  return result.rows.map(toObject);
}

async function get(sql, args = {}) {
  const rows = await all(sql, args);
  return rows.length ? rows[0] : null;
}

async function run(sql, args = {}) {
  return db.execute({ sql, args });
}

const INSERT_KILLMAIL = `
  INSERT INTO killmails
    (hash, killed_at, victim_name, victim_corp, victim_alliance, victim_faction,
     ship, system, security, damage_taken, total_damage, attacker_count, final_blow, raw)
  VALUES
    (:hash, :killed_at, :victim_name, :victim_corp, :victim_alliance, :victim_faction,
     :ship, :system, :security, :damage_taken, :total_damage, :attacker_count, :final_blow, :raw)
`;

const INSERT_ATTACKER = `
  INSERT INTO attackers
    (killmail_id, position, name, security, corp, alliance, faction, ship, weapon, damage, final_blow)
  VALUES
    (:killmail_id, :position, :name, :security, :corp, :alliance, :faction, :ship, :weapon, :damage, :final_blow)
`;

const INSERT_ITEM = `
  INSERT INTO items (killmail_id, name, qty, location, status)
  VALUES (:killmail_id, :name, :qty, :location, :status)
`;

/**
 * Stores a parsed killmail in one transaction. Returns { id, duplicate }.
 * Duplicates (same hash) are a no-op so re-pasting is safe.
 */
async function storeKillmail(km) {
  const existing = await get('SELECT id FROM killmails WHERE hash = :hash', { hash: km.hash });
  if (existing) return { id: existing.id, duplicate: true };

  const tx = await db.transaction('write');
  try {
    const inserted = await tx.execute({
      sql: INSERT_KILLMAIL,
      args: {
        hash: km.hash,
        killed_at: km.killedAt,
        victim_name: km.victim.name,
        victim_corp: km.victim.corp,
        victim_alliance: km.victim.alliance,
        victim_faction: km.victim.faction,
        ship: km.victim.ship,
        system: km.victim.system,
        security: km.victim.security,
        damage_taken: km.victim.damageTaken,
        total_damage: km.totalDamage,
        attacker_count: km.attackers.length,
        final_blow: km.finalBlow ? km.finalBlow.name : null,
        raw: km.raw,
      },
    });

    const killmailId = Number(inserted.lastInsertRowid);

    for (const [position, a] of km.attackers.entries()) {
      await tx.execute({
        sql: INSERT_ATTACKER,
        args: {
          killmail_id: killmailId,
          position,
          name: a.name,
          security: a.security,
          corp: a.corp,
          alliance: a.alliance,
          faction: a.faction,
          ship: a.ship,
          weapon: a.weapon,
          damage: Math.round(a.damage || 0),
          final_blow: a.finalBlow ? 1 : 0,
        },
      });
    }

    for (const item of km.items) {
      await tx.execute({
        sql: INSERT_ITEM,
        args: {
          killmail_id: killmailId,
          name: item.name,
          qty: item.qty,
          location: item.location,
          status: item.status,
        },
      });
    }

    await tx.commit();
    return { id: killmailId, duplicate: false };
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

/**
 * Children are removed explicitly rather than through ON DELETE CASCADE:
 * foreign-key enforcement depends on a PRAGMA that is not reliably settable
 * over a remote libSQL connection.
 */
async function deleteKillmail(id) {
  const tx = await db.transaction('write');
  try {
    await tx.execute({ sql: 'DELETE FROM attackers WHERE killmail_id = :id', args: { id } });
    await tx.execute({ sql: 'DELETE FROM items WHERE killmail_id = :id', args: { id } });
    const result = await tx.execute({ sql: 'DELETE FROM killmails WHERE id = :id', args: { id } });
    await tx.commit();
    return result.rowsAffected > 0;
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

module.exports = { db, migrate, all, get, run, storeKillmail, deleteKillmail, config };
