'use strict';

const express = require('express');
const auth = require('../auth');
const { ingestText } = require('../ingest');
const q = require('../queries');
const { wrap } = require('../async');

const router = express.Router();

/** Always reachable — Render's health check runs before anyone can log in. */
router.get('/health', (req, res) => res.json({ ok: true }));

/** Public read endpoints are gated the same way the site is. */
router.use((req, res, next) => (req.method === 'POST' ? next() : auth.requireSite(req, res, next)));

function serialiseKill(k) {
  return {
    id: k.id,
    url: `/kill/${k.id}`,
    killed_at: k.killed_at,
    victim: {
      name: k.victim_name,
      corporation: k.victim_corp,
      alliance: k.victim_alliance,
      ship: k.ship,
    },
    system: k.system,
    security: k.security,
    damage_taken: k.damage_taken,
    attackers: k.attacker_count,
    final_blow: k.final_blow,
  };
}

/**
 * POST /api/killmails
 * Body: raw text (Content-Type: text/plain) or JSON { killmail: "..." }.
 * Accepts several killmails in one request.
 */
router.post('/killmails', auth.requireApiKey, wrap(async (req, res) => {
  const text = typeof req.body === 'string' ? req.body : (req.body && req.body.killmail) || '';
  if (!text.trim()) return res.status(400).json({ error: 'Empty body. Send the killmail text.' });

  const result = await ingestText(text);
  const status = result.created.length ? 201 : result.errors.length ? 400 : 200;

  res.status(status).json({
    created: result.created.map((c) => ({ ...c, url: `/kill/${c.id}` })),
    duplicates: result.duplicates,
    errors: result.errors,
  });
}));

router.get('/killmails', wrap(async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const feed = await q.listKills({ page, pageSize: 50 });
  res.json({
    page: feed.page,
    pages: feed.pages,
    total: feed.total,
    killmails: feed.rows.map(serialiseKill),
  });
}));

router.get('/killmails/:id', wrap(async (req, res) => {
  const kill = await q.getKillmail(Number.parseInt(req.params.id, 10));
  if (!kill) return res.status(404).json({ error: 'Not found' });

  res.json({
    ...serialiseKill(kill),
    involved: kill.attackers.map((a) => ({
      name: a.name, security: a.security, corporation: a.corp, alliance: a.alliance,
      ship: a.ship, weapon: a.weapon, damage: a.damage, final_blow: Boolean(a.final_blow),
    })),
    destroyed_items: kill.destroyedItems.map((i) => ({ name: i.name, qty: i.qty, location: i.location })),
    dropped_items: kill.droppedItems.map((i) => ({ name: i.name, qty: i.qty, location: i.location })),
  });
}));

router.get('/stats', wrap(async (req, res) => res.json(await q.boardSummary())));

module.exports = router;
