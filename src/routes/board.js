'use strict';

const express = require('express');
const q = require('../queries');
const { wrap } = require('../async');

const router = express.Router();

const ENTITY_KINDS = {
  character: 'Pilot',
  corporation: 'Corporation',
  alliance: 'Alliance',
  system: 'System',
  ship: 'Ship',
};

function pageParam(req) {
  const n = Number.parseInt(req.query.page, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

router.get('/', wrap(async (req, res) => {
  const page = pageParam(req);

  // Fall back to all-time rankings when the last 30 days were quiet.
  const days = (await q.killsSince(30)) > 0 ? 30 : null;
  const windowLabel = days ? '30d' : 'all time';

  const [feed, summary, activity, topPilots, topCorps, topAlliances, topSystems, topShips] =
    await Promise.all([
      q.listKills({ page, pageSize: 25 }),
      q.boardSummary(),
      q.activity(30),
      q.leaderboard('name', { days }),
      q.leaderboard('corp', { days }),
      q.leaderboard('alliance', { days }),
      q.topSystems({ days }),
      q.leaderboard('ship', { days }),
    ]);

  res.render('home', {
    title: 'Recent kills',
    feed, summary, activity, windowLabel,
    topPilots, topCorps, topAlliances, topSystems, topShips,
  });
}));

router.get('/kills', wrap(async (req, res) => {
  const feed = await q.listKills({ page: pageParam(req), pageSize: 50 });
  res.render('kills', { title: 'All killmails', feed });
}));

router.get('/kill/:id', wrap(async (req, res, next) => {
  const kill = await q.getKillmail(Number.parseInt(req.params.id, 10));
  if (!kill) return next();

  // A battle report centred on this kill: an hour either side, same system.
  const at = new Date(kill.killed_at).getTime();
  const battleQuery = new URLSearchParams({
    from: new Date(at - 3600e3).toISOString().slice(0, 16),
    to: new Date(at + 3600e3).toISOString().slice(0, 16),
  });
  if (kill.system) battleQuery.set('system', kill.system);

  res.render('kill', {
    title: `${kill.victim_name} — ${kill.ship}`,
    kill,
    battleUrl: `/battle?${battleQuery}`,
  });
}));

router.get('/kill/:id/raw', wrap(async (req, res, next) => {
  const kill = await q.getKillmail(Number.parseInt(req.params.id, 10));
  if (!kill) return next();
  res.type('text/plain').send(kill.raw);
}));

for (const [kind, label] of Object.entries(ENTITY_KINDS)) {
  router.get(`/${kind}/:name`, wrap(async (req, res) => {
    const name = req.params.name;
    const side = ['kills', 'losses', 'all'].includes(req.query.side) ? req.query.side : 'all';
    const clause = q.entityClause(kind, name, side);
    const isSystem = kind === 'system';

    const [feed, stats, topCorps, topShips, lostShips] = await Promise.all([
      q.listKills({ ...clause, page: pageParam(req), pageSize: 25 }),
      q.entityStats(kind, name),
      isSystem ? [] : q.topAssociates(kind, name, 'corp'),
      isSystem ? [] : q.topAssociates(kind, name, 'ship'),
      isSystem ? [] : q.shipBreakdown(kind, name),
    ]);

    res.render('entity', {
      title: name,
      kind,
      kindLabel: label,
      name,
      side,
      feed, stats, topCorps, topShips, lostShips,
    });
  }));
}

router.get('/search', wrap(async (req, res) => {
  const term = (req.query.q || '').trim();
  const results = term.length >= 2 ? await q.search(term) : [];

  // A single exact hit is almost always what the user typed — jump straight there.
  const exact = results.filter((r) => r.label.toLowerCase() === term.toLowerCase());
  if (exact.length === 1) {
    return res.redirect(`/${exact[0].kind}/${encodeURIComponent(exact[0].label)}`);
  }

  res.render('search', { title: `Search: ${term}`, term, results });
}));

module.exports = router;
