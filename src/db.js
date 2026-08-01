'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'killboard.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
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
`);

const insertKillmailStmt = db.prepare(`
  INSERT INTO killmails
    (hash, killed_at, victim_name, victim_corp, victim_alliance, victim_faction,
     ship, system, security, damage_taken, total_damage, attacker_count, final_blow, raw)
  VALUES
    (@hash, @killed_at, @victim_name, @victim_corp, @victim_alliance, @victim_faction,
     @ship, @system, @security, @damage_taken, @total_damage, @attacker_count, @final_blow, @raw)
`);

const insertAttackerStmt = db.prepare(`
  INSERT INTO attackers
    (killmail_id, position, name, security, corp, alliance, faction, ship, weapon, damage, final_blow)
  VALUES
    (@killmail_id, @position, @name, @security, @corp, @alliance, @faction, @ship, @weapon, @damage, @final_blow)
`);

const insertItemStmt = db.prepare(`
  INSERT INTO items (killmail_id, name, qty, location, status)
  VALUES (@killmail_id, @name, @qty, @location, @status)
`);

const findByHashStmt = db.prepare('SELECT id FROM killmails WHERE hash = ?');

/**
 * Stores a parsed killmail. Returns { id, duplicate }.
 * Duplicates (same hash) are a no-op so re-pasting is safe.
 */
const storeKillmail = db.transaction((km) => {
  const existing = findByHashStmt.get(km.hash);
  if (existing) return { id: existing.id, duplicate: true };

  const info = insertKillmailStmt.run({
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
  });

  const killmailId = Number(info.lastInsertRowid);

  km.attackers.forEach((a, i) => {
    insertAttackerStmt.run({
      killmail_id: killmailId,
      position: i,
      name: a.name,
      security: a.security,
      corp: a.corp,
      alliance: a.alliance,
      faction: a.faction,
      ship: a.ship,
      weapon: a.weapon,
      damage: Math.round(a.damage || 0),
      final_blow: a.finalBlow ? 1 : 0,
    });
  });

  for (const item of km.items) {
    insertItemStmt.run({
      killmail_id: killmailId,
      name: item.name,
      qty: item.qty,
      location: item.location,
      status: item.status,
    });
  }

  return { id: killmailId, duplicate: false };
});

function deleteKillmail(id) {
  return db.prepare('DELETE FROM killmails WHERE id = ?').run(id).changes > 0;
}

module.exports = { db, storeKillmail, deleteKillmail, DATA_DIR };
