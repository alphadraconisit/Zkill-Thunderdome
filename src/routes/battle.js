'use strict';

const express = require('express');
const q = require('../queries');
const { analyseBattle, formatDuration } = require('../battle');
const { damageTimeline } = require('../chart');
const { wrap } = require('../async');

const router = express.Router();

const PRESETS = {
  '1h': { label: 'Last hour', ms: 3600e3 },
  '6h': { label: 'Last 6 hours', ms: 6 * 3600e3 },
  '24h': { label: 'Last 24 hours', ms: 24 * 3600e3 },
  '7d': { label: 'Last 7 days', ms: 7 * 86400e3 },
  '30d': { label: 'Last 30 days', ms: 30 * 86400e3 },
};

/**
 * `datetime-local` inputs speak "YYYY-MM-DDTHH:MM" with no zone. The board is
 * EVE time throughout, so those are read as UTC rather than the viewer's zone.
 */
function parseWindowInput(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  const normalised = /Z$|[+-]\d{2}:\d{2}$/.test(text) ? text : `${text.replace(' ', 'T')}Z`;
  const ms = Date.parse(normalised);
  return Number.isFinite(ms) ? ms : null;
}

function toInputValue(iso) {
  return iso ? iso.slice(0, 16) : '';
}

/** Resolves the requested window, falling back to a sensible default. */
function resolveWindow(query) {
  const preset = PRESETS[query.preset];
  if (preset) {
    const to = Date.now();
    return { from: to - preset.ms, to, preset: query.preset };
  }

  const from = parseWindowInput(query.from);
  const to = parseWindowInput(query.to);

  if (from != null && to != null) {
    return from <= to ? { from, to, preset: null } : { from: to, to: from, preset: null };
  }
  if (from != null) return { from, to: from + 24 * 3600e3, preset: null };
  if (to != null) return { from: to - 24 * 3600e3, to, preset: null };

  const now = Date.now();
  return { from: now - PRESETS['24h'].ms, to: now, preset: '24h' };
}

router.get('/', wrap(async (req, res) => {
  const { from, to, preset } = resolveWindow(req.query);
  const system = (req.query.system || '').trim() || null;

  const fromIso = new Date(from).toISOString();
  const toIso = new Date(to).toISOString();

  const [{ kills, attackers, truncated }, systems] = await Promise.all([
    q.battleWindow({ from: fromIso, to: toIso, system }),
    q.systemsWithKills(),
  ]);

  const report = analyseBattle(kills, attackers);
  const chart = damageTimeline(report.timeline.series);

  res.render('battle', {
    title: 'Battle report',
    kills,
    report,
    chart,
    truncated,
    limit: q.BATTLE_LIMIT,
    systems,
    system,
    presets: PRESETS,
    preset,
    window: { from: fromIso, to: toIso, fromInput: toInputValue(fromIso), toInput: toInputValue(toIso) },
    duration: formatDuration(to - from),
  });
}));

module.exports = router;
