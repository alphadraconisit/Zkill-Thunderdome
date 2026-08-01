'use strict';

const express = require('express');
const auth = require('../auth');
const { ingestText } = require('../ingest');
const { deleteKillmail } = require('../db');
const q = require('../queries');
const esi = require('../esi');

const router = express.Router();
router.use(auth.requireAdmin);

router.get('/', (req, res) => {
  res.render('admin', {
    title: 'Submit killmail',
    result: null,
    text: '',
    recent: q.listKills({ page: 1, pageSize: 15 }).rows,
    summary: q.boardSummary(),
    apiEnabled: Boolean(auth.API_KEY),
    esiEnabled: esi.ENABLED,
  });
});

router.post('/submit', (req, res) => {
  const text = req.body.killmail || '';
  const result = ingestText(text);

  res.render('admin', {
    title: 'Submit killmail',
    result,
    // Keep the paste around when something failed so it can be corrected.
    text: result.errors.length ? text : '',
    recent: q.listKills({ page: 1, pageSize: 15 }).rows,
    summary: q.boardSummary(),
    apiEnabled: Boolean(auth.API_KEY),
    esiEnabled: esi.ENABLED,
  });
});

router.post('/delete/:id', (req, res) => {
  deleteKillmail(Number.parseInt(req.params.id, 10));
  res.redirect('/admin');
});

router.post('/resolve-images', async (req, res) => {
  await esi.resolveNames(q.distinctShipNames(), { force: true }).catch(() => {});
  res.redirect('/admin');
});

module.exports = router;
