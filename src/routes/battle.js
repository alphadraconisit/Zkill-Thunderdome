'use strict';

const express = require('express');
const q = require('../queries');
const { analyseBattle, formatDuration } = require('../battle');
const { detectBattles, findBattleContaining, DEFAULTS } = require('../battles');
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

/**
 * Reports are anchored to a killmail rather than a time range: a window can
 * span several battles in one evening, an anchor names exactly one.
 */
function reportUrl(battle) {
  return `/battle/report?kill=${battle.killIds[0]}`;
}

/** How far either side of the anchor to look when rebuilding its battle. */
const ANCHOR_SCAN_MS = 6 * 3600e3;

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

/**
 * Rebuilds the single battle a killmail belongs to. Returns null when the
 * anchor no longer exists.
 */
async function battleForKill(killId, gapMinutes) {
  const anchor = await q.getKillmail(killId);
  if (!anchor) return null;

  const at = new Date(anchor.killed_at).getTime();
  const scan = await q.battleScan({
    from: new Date(at - ANCHOR_SCAN_MS).toISOString(),
    to: new Date(at + ANCHOR_SCAN_MS).toISOString(),
  });

  const battle = findBattleContaining(scan.kills, scan.attackers, killId, { gapMinutes });
  if (!battle) return null;

  const { kills, attackers } = await q.killmailsByIds(battle.killIds);
  return { battle, kills, attackers };
}

/**
 * The detailed report.
 *
 * `?kill=<id>` reports on exactly the battle that killmail belongs to — the
 * normal path in from the battles list. `?from&to[&system]` keeps the manual
 * window, which may legitimately span several battles; when it does, they are
 * listed so the reader can open one on its own.
 */
router.get('/report', wrap(async (req, res, next) => {
  const anchorId = Number.parseInt(req.query.kill, 10);
  const gapMinutes = Math.min(180, Math.max(1,
    Number.parseInt(req.query.gap, 10) || DEFAULTS.gapMinutes));

  const systemsPromise = q.systemsWithKills();
  let kills;
  let attackers;
  let truncated = false;
  let anchored = null;
  let system = (req.query.system || '').trim() || null;
  let from;
  let to;

  if (Number.isFinite(anchorId)) {
    const found = await battleForKill(anchorId, gapMinutes);
    if (!found) return next();

    ({ kills, attackers } = found);
    anchored = found.battle;
    system = found.battle.system && found.battle.system !== '(unknown)' ? found.battle.system : null;
    from = found.battle.startMs;
    to = found.battle.endMs;
  } else {
    ({ from, to } = resolveWindow(req.query));
    const window = await q.battleWindow({
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      system,
    });
    kills = window.kills;
    attackers = window.attackers;
    truncated = window.truncated;
  }

  const report = analyseBattle(kills, attackers);
  const chart = damageTimeline(report.timeline.series);

  // In window mode, tell the reader when they are looking at more than one fight.
  const contained = anchored
    ? []
    : detectBattles(kills, attackers, { gapMinutes, minKills: 1 })
      .map((b) => ({ ...b, url: reportUrl(b) }));

  const fromIso = new Date(from).toISOString();
  const toIso = new Date(to).toISOString();

  res.render('battle', {
    title: anchored ? `Battle in ${anchored.system}` : 'Battle report',
    kills,
    report,
    chart,
    truncated,
    limit: q.BATTLE_LIMIT,
    systems: await systemsPromise,
    system,
    presets: PRESETS,
    preset: anchored ? null : resolveWindow(req.query).preset,
    anchored,
    contained,
    gapMinutes,
    window: { from: fromIso, to: toIso, fromInput: toInputValue(fromIso), toInput: toInputValue(toIso) },
    duration: formatDuration(to - from),
  });
}));

module.exports = router;
