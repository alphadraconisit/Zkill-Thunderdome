'use strict';

const express = require('express');
const q = require('../queries');

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

router.get('/', (req, res) => {
  const page = pageParam(req);
  const feed = q.listKills({ page, pageSize: 25 });

  // Fall back to all-time rankings when the last 30 days were quiet.
  const days = q.killsSince(30) > 0 ? 30 : null;
  const windowLabel = days ? '30d' : 'all time';

  res.render('home', {
    title: 'Recent kills',
    feed,
    windowLabel,
    summary: q.boardSummary(),
    activity: q.activity(30),
    topPilots: q.leaderboard('name', { days }),
    topCorps: q.leaderboard('corp', { days }),
    topAlliances: q.leaderboard('alliance', { days }),
    topSystems: q.topSystems({ days }),
    topShips: q.leaderboard('ship', { days }),
  });
});

router.get('/kills', (req, res) => {
  const feed = q.listKills({ page: pageParam(req), pageSize: 50 });
  res.render('kills', { title: 'All killmails', feed });
});

router.get('/kill/:id', (req, res, next) => {
  const kill = q.getKillmail(Number.parseInt(req.params.id, 10));
  if (!kill) return next();

  res.render('kill', {
    title: `${kill.victim_name} — ${kill.ship}`,
    kill,
  });
});

router.get('/kill/:id/raw', (req, res, next) => {
  const kill = q.getKillmail(Number.parseInt(req.params.id, 10));
  if (!kill) return next();
  res.type('text/plain').send(kill.raw);
});

for (const [kind, label] of Object.entries(ENTITY_KINDS)) {
  router.get(`/${kind}/:name`, (req, res) => {
    const name = req.params.name;
    const side = ['kills', 'losses', 'all'].includes(req.query.side) ? req.query.side : 'all';
    const clause = q.entityClause(kind, name, side);
    const feed = q.listKills({ ...clause, page: pageParam(req), pageSize: 25 });

    res.render('entity', {
      title: name,
      kind,
      kindLabel: label,
      name,
      side,
      feed,
      stats: q.entityStats(kind, name),
      topCorps: kind === 'system' ? [] : q.topAssociates(kind, name, 'corp'),
      topShips: kind === 'system' ? [] : q.topAssociates(kind, name, 'ship'),
      lostShips: kind === 'system' ? [] : q.shipBreakdown(kind, name),
    });
  });
}

router.get('/search', (req, res) => {
  const term = (req.query.q || '').trim();
  const results = term.length >= 2 ? q.search(term) : [];

  // A single exact hit is almost always what the user typed — jump straight there.
  const exact = results.filter((r) => r.label.toLowerCase() === term.toLowerCase());
  if (exact.length === 1) {
    return res.redirect(`/${exact[0].kind}/${encodeURIComponent(exact[0].label)}`);
  }

  res.render('search', { title: `Search: ${term}`, term, results });
});

module.exports = router;
