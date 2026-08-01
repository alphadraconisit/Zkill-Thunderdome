'use strict';

const { all, run } = require('./db');

const ESI_IDS_URL = 'https://esi.evetech.net/latest/universe/ids/';
const ENABLED = process.env.ESI_LOOKUP !== '0';
const USER_AGENT = process.env.ESI_USER_AGENT
  || `zkill-thunderdome (${process.env.CONTACT_EMAIL || 'private killboard'})`;

const RETRY_AFTER_MS = 7 * 24 * 3600 * 1000;

/**
 * Name -> type ID, mirrored in memory.
 *
 * Templates ask for artwork while rendering, which cannot await a query, so
 * the whole table is held in memory. It is one small row per distinct ship and
 * item name, and it is only ever appended to.
 */
const cache = new Map();

async function loadCache() {
  cache.clear();
  const rows = await all('SELECT name, type_id, resolved_at FROM type_ids');
  for (const row of rows) {
    cache.set(row.name.toLowerCase(), { name: row.name, typeId: row.type_id, resolvedAt: row.resolved_at });
  }
  return cache.size;
}

/** Cached lookup only — never blocks a render on the network or on I/O. */
function typeIdFor(name) {
  if (!name) return null;
  const entry = cache.get(String(name).toLowerCase());
  return entry ? entry.typeId : null;
}

function shipImage(name, size = 64) {
  const id = typeIdFor(name);
  return id ? `https://images.evetech.net/types/${id}/render?size=${size}` : null;
}

function itemIcon(name, size = 32) {
  const id = typeIdFor(name);
  return id ? `https://images.evetech.net/types/${id}/icon?size=${size}` : null;
}

async function remember(name, typeId) {
  await run(`
    INSERT INTO type_ids (name, type_id, resolved_at) VALUES (@name, @type_id, datetime('now'))
    ON CONFLICT(name) DO UPDATE SET type_id = excluded.type_id, resolved_at = excluded.resolved_at
  `, { name, type_id: typeId });
  cache.set(name.toLowerCase(), { name, typeId, resolvedAt: new Date().toISOString() });
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

  for (const name of names) {
    await remember(name, found.get(name.toLowerCase()) ?? null);
  }
}

/**
 * Resolves any names we have not seen before. Fire-and-forget: image art is
 * cosmetic, so failures are logged and retried on the next submission.
 */
async function resolveNames(names, { force = false } = {}) {
  if (!ENABLED) return;

  const unique = [...new Set(names.filter(Boolean))];
  const pending = force ? unique : unique.filter((n) => !cache.has(n.toLowerCase()));
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

  const cutoff = Date.now() - RETRY_AFTER_MS;
  const stale = [];
  for (const entry of cache.values()) {
    // Retry with the original spelling, not the lower-cased cache key.
    if (entry.typeId == null && new Date(entry.resolvedAt).getTime() < cutoff) stale.push(entry.name);
  }
  if (stale.length) await resolveNames(stale, { force: true });
}

module.exports = { loadCache, resolveNames, retryUnresolved, typeIdFor, shipImage, itemIcon, ENABLED };
