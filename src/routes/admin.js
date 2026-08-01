'use strict';

const express = require('express');
const auth = require('../auth');
const { ingestText } = require('../ingest');
const { deleteKillmail } = require('../db');
const q = require('../queries');
const esi = require('../esi');
const { wrap } = require('../async');

const router = express.Router();
router.use(auth.requireAdmin);

async function adminView(result, text) {
  const [recent, summary] = await Promise.all([
    q.listKills({ page: 1, pageSize: 15 }),
    q.boardSummary(),
  ]);

  return {
    title: 'Submit killmail',
    result,
    text,
    recent: recent.rows,
    summary,
    apiEnabled: Boolean(auth.API_KEY),
    esiEnabled: esi.ENABLED,
  };
}

router.get('/', wrap(async (req, res) => {
  res.render('admin', await adminView(null, ''));
}));

router.post('/submit', wrap(async (req, res) => {
  const text = req.body.killmail || '';
  const result = await ingestText(text);

  // Keep the paste around when something failed so it can be corrected.
  res.render('admin', await adminView(result, result.errors.length ? text : ''));
}));

router.post('/delete/:id', wrap(async (req, res) => {
  await deleteKillmail(Number.parseInt(req.params.id, 10));
  res.redirect('/admin');
}));

router.post('/resolve-images', wrap(async (req, res) => {
  const names = await q.distinctShipNames();
  await esi.resolveNames(names, { force: true }).catch(() => {});
  res.redirect('/admin');
}));

module.exports = router;
