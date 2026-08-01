'use strict';

const { parseKillmail, splitKillmails } = require('./parser');
const { storeKillmail } = require('./db');
const esi = require('./esi');

/**
 * Parses and stores one or more pasted killmails.
 * Never throws for bad input — malformed blocks come back in `errors` so a
 * batch paste is not lost because of one broken mail.
 */
function ingestText(text) {
  const blocks = splitKillmails(text);
  const result = { created: [], duplicates: 0, errors: [] };

  if (!blocks.length) {
    result.errors.push({ index: 0, message: 'No killmail found. Expected a "YYYY.MM.DD HH:MM:SS" line to start the mail.' });
    return result;
  }

  const names = new Set();

  blocks.forEach((block, index) => {
    let km;
    try {
      km = parseKillmail(block);
    } catch (err) {
      result.errors.push({ index, message: err.message, excerpt: block.slice(0, 120) });
      return;
    }

    try {
      const { id, duplicate } = storeKillmail(km);
      if (duplicate) {
        result.duplicates += 1;
        return;
      }
      result.created.push({ id, victim: km.victim.name, ship: km.victim.ship, system: km.victim.system });
      names.add(km.victim.ship);
      for (const a of km.attackers) if (a.ship) names.add(a.ship);
      for (const i of km.items) names.add(i.name);
    } catch (err) {
      result.errors.push({ index, message: `Could not store killmail: ${err.message}` });
    }
  });

  if (names.size) {
    esi.resolveNames([...names]).catch((err) => console.warn('[ingest] esi:', err.message));
  }

  return result;
}

module.exports = { ingestText };
