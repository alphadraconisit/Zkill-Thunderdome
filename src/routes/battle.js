'use strict';

const express = require('express');
const q = require('../queries');
const { analyseBattle, formatDuration } = require('../battle');
const { detectBattles, DEFAULTS } = require('../battles');
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

const SCAN_PRESETS = {
  '24h': { label: 'Last 24 hours', ms: 24 * 3600e3 },
  '7d': { label: 'Last 7 days', ms: 7 * 86400e3 },
  '30d': { label: 'Last 30 days', ms: 30 * 86400e3 },
  '90d': { label: 'Last 90 days', ms: 90 * 86400e3 },
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

/** Padding so a battle's own killmails sit comfortably inside its report. */
const REPORT_PAD_MS = 60000;

function reportUrl(battle) {
  const params = new URLSearchParams({
    from: new Date(battle.startMs - REPORT_PAD_MS).toISOString().slice(0, 16),
    to: new Date(battle.endMs + REPORT_PAD_MS).toISOString().slice(0, 16),
  });
  if (battle.system && battle.system !== '(unknown)') params.set('system', battle.system);
  return `/battle/report?${params}`;
}

/** Battles index — detected fights, most recent first. */
router.get('/', wrap(async (req, res) => {
  const scanKey = SCAN_PRESETS[req.query.scan] ? req.query.scan : '30d';
  const to = Date.now();
  const from = to - SCAN_PRESETS[scanKey].ms;

  const gapMinutes = Math.min(180, Math.max(1,
    Number.parseInt(req.query.gap, 10) || DEFAULTS.gapMinutes));
  const minKills = Math.min(50, Math.max(1,
    Number.parseInt(req.query.min, 10) || DEFAULTS.minKills));

  const [{ kills, attackers, truncated }, systems] = await Promise.all([
    q.battleScan({ from: new Date(from).toISOString(), to: new Date(to).toISOString() }),
    q.systemsWithKills(60),
  ]);

  const battles = detectBattles(kills, attackers, { gapMinutes, minKills });

  res.render('battles', {
    title: 'Battles',
    battles: battles.map((b) => ({ ...b, url: reportUrl(b) })),
    scanned: kills.length,
    truncated,
    scanLimit: q.SCAN_LIMIT,
    scanKey,
    scanPresets: SCAN_PRESETS,
    gapMinutes,
    minKills,
    systems,
    windowLabel: SCAN_PRESETS[scanKey].label.toLowerCase(),
  });
}));

/** The detailed report for one window. */
router.get('/report', wrap(async (req, res) => {
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
