'use strict';

const { db } = require('./db');

const ESI_IDS_URL = 'https://esi.evetech.net/latest/universe/ids/';
const ENABLED = process.env.ESI_LOOKUP !== '0';
const USER_AGENT = process.env.ESI_USER_AGENT
  || `zkill-thunderdome (${process.env.CONTACT_EMAIL || 'private killboard'})`;

const getStmt = db.prepare('SELECT type_id FROM type_ids WHERE name = ? COLLATE NOCASE');
const upsertStmt = db.prepare(`
  INSERT INTO type_ids (name, type_id, resolved_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(name) DO UPDATE SET type_id = excluded.type_id, resolved_at = excluded.resolved_at
`);
const unresolvedStmt = db.prepare(`
  SELECT name FROM type_ids WHERE type_id IS NULL AND resolved_at < datetime('now', '-7 days')
`);

/** Cached lookup only — never blocks a request on the network. */
function typeIdFor(name) {
  if (!name) return null;
  const row = getStmt.get(name);
  return row ? row.type_id : null;
}

function shipImage(name, size = 64) {
  const id = typeIdFor(name);
  return id ? `https://images.evetech.net/types/${id}/render?size=${size}` : null;
}

function itemIcon(name, size = 32) {
  const id = typeIdFor(name);
  return id ? `https://images.evetech.net/types/${id}/icon?size=${size}` : null;
}

async function resolveChunk(names) {
  const res = await fetch(ESI_IDS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify(names),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`ESI ${res.status} ${res.statusText}`);

  const body = await res.json();
  const found = new Map();
  for (const t of body.inventory_types || []) found.set(t.name.toLowerCase(), t.id);

  const write = db.transaction(() => {
    for (const name of names) {
      upsertStmt.run(name, found.get(name.toLowerCase()) ?? null);
    }
  });
  write();
}

/**
 * Resolves any names we have not seen before. Fire-and-forget: image art is
 * cosmetic, so failures are logged and retried on the next submission.
 */
async function resolveNames(names, { force = false } = {}) {
  if (!ENABLED) return;

  const unique = [...new Set(names.filter(Boolean))];
  const pending = force ? unique : unique.filter((n) => !getStmt.get(n));
  if (!pending.length) return;

  for (let i = 0; i < pending.length; i += 100) {
    try {
      await resolveChunk(pending.slice(i, i + 100));
    } catch (err) {
      console.warn('[esi] name resolution failed:', err.message);
      return;
    }
  }
}

/** Retries names ESI did not know about, in case they were typos since fixed. */
async function retryUnresolved() {
  if (!ENABLED) return;
  const names = unresolvedStmt.all().map((r) => r.name);
  if (names.length) await resolveNames(names, { force: true });
}

module.exports = { resolveNames, retryUnresolved, typeIdFor, shipImage, itemIcon, ENABLED };
