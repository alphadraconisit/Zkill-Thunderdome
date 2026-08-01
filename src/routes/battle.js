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
 *
 * Detection settings ride along, because the report re-runs detection to
 * rebuild the battle and must reach the same answer the list showed.
 */
function reportUrl(battle, settings = {}) {
  const params = new URLSearchParams({ kill: String(battle.killIds[0]) });
  if (settings.gapMinutes && settings.gapMinutes !== DEFAULTS.gapMinutes) {
    params.set('gap', String(settings.gapMinutes));
  }
  if (settings.lullFactor !== undefined && settings.lullFactor !== DEFAULTS.lullFactor) {
    params.set('lull', String(settings.lullFactor));
  }
  return `/battle/report?${params}`;
}

/** Shared parsing so the index and the report agree on detection settings. */
function detectionSettings(query) {
  return {
    gapMinutes: Math.min(180, Math.max(1,
      Number.parseInt(query.gap, 10) || DEFAULTS.gapMinutes)),
    lullFactor: query.lull === undefined
      ? DEFAULTS.lullFactor
      : Math.min(20, Math.max(0, Number.parseInt(query.lull, 10) || 0)),
  };
}

/** How far either side of the anchor to look when rebuilding its battle. */
const ANCHOR_SCAN_MS = 6 * 3600e3;

/** Battles index — detected fights, most recent first. */
router.get('/', wrap(async (req, res) => {
  const scanKey = SCAN_PRESETS[req.query.scan] ? req.query.scan : '30d';
  const to = Date.now();
  const from = to - SCAN_PRESETS[scanKey].ms;

  // `lull=0` turns off pace-relative splitting and uses the flat gap alone.
  const { gapMinutes, lullFactor } = detectionSettings(req.query);
  const minKills = Math.min(50, Math.max(1,
    Number.parseInt(req.query.min, 10) || DEFAULTS.minKills));

  const [{ kills, attackers, truncated }, systems] = await Promise.all([
    q.battleScan({ from: new Date(from).toISOString(), to: new Date(to).toISOString() }),
    q.systemsWithKills(60),
  ]);

  const battles = detectBattles(kills, attackers, { gapMinutes, minKills, lullFactor });

  res.render('battles', {
    title: 'Battles',
    battles: battles.map((b) => ({ ...b, url: reportUrl(b, { gapMinutes, lullFactor }) })),
    scanned: kills.length,
    truncated,
    scanLimit: q.SCAN_LIMIT,
    scanKey,
    scanPresets: SCAN_PRESETS,
    gapMinutes,
    minKills,
    lullFactor,
    lullFloorMinutes: DEFAULTS.lullFloorMinutes,
    systems,
    windowLabel: SCAN_PRESETS[scanKey].label.toLowerCase(),
  });
}));

/**
 * Rebuilds the single battle a killmail belongs to. Returns null when the
 * anchor no longer exists.
 */
async function battleForKill(killId, settings) {
  const anchor = await q.getKillmail(killId);
  if (!anchor) return null;

  const at = new Date(anchor.killed_at).getTime();
  const scan = await q.battleScan({
    from: new Date(at - ANCHOR_SCAN_MS).toISOString(),
    to: new Date(at + ANCHOR_SCAN_MS).toISOString(),
  });

  const battle = findBattleContaining(scan.kills, scan.attackers, killId, settings);
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
const MAX_SELECTED = 250;

/** `?ids=1,2,3` — an explicit hand-picked selection of killmails. */
function parseIds(value) {
  if (!value) return [];
  return [...new Set(String(value)
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((id) => Number.isFinite(id) && id > 0))]
    .slice(0, MAX_SELECTED);
}

router.get('/report', wrap(async (req, res, next) => {
  const selectedIds = parseIds(req.query.ids);
  const anchorId = Number.parseInt(req.query.kill, 10);
  const { gapMinutes, lullFactor } = detectionSettings(req.query);

  const systemsPromise = q.systemsWithKills();
  let kills;
  let attackers;
  let truncated = false;
  let anchored = null;
  let system = (req.query.system || '').trim() || null;
  let from;
  let to;

  let selection = null;

  if (selectedIds.length) {
    ({ kills, attackers } = await q.killmailsByIds(selectedIds));
    if (!kills.length) return next();

    selection = { requested: selectedIds.length, found: kills.length };
    from = new Date(kills[0].killed_at).getTime();
    to = new Date(kills[kills.length - 1].killed_at).getTime();
    const systems = [...new Set(kills.map((k) => k.system).filter(Boolean))];
    system = systems.length === 1 ? systems[0] : null;
  } else if (Number.isFinite(anchorId)) {
    const found = await battleForKill(anchorId, { gapMinutes, lullFactor });
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

  // One marker per ship lost, coloured by the side that lost it, so the lane
  // under the axis reads as "what died, when, and on whose side".
  const sideOfPilot = new Map();
  report.teams.forEach((team, index) => {
    for (const pilot of team.pilots) sideOfPilot.set(pilot.name.toLowerCase(), index);
  });

  const losses = kills.map((k) => ({
    t: new Date(k.killed_at).getTime(),
    id: k.id,
    ship: k.ship,
    victim: k.victim_name,
    time: k.killed_at,
    sideIndex: sideOfPilot.get((k.victim_name || '').toLowerCase()) ?? 0,
  }));

  const chart = damageTimeline(report.timeline.series, losses);

  // Outside battle mode, tell the reader when they are looking at more than one
  // fight — a window or a hand-picked selection can easily span several.
  const contained = anchored
    ? []
    : detectBattles(kills, attackers, { gapMinutes, lullFactor, minKills: 1 })
      .map((b) => ({ ...b, url: reportUrl(b, { gapMinutes, lullFactor }) }));

  const fromIso = new Date(from).toISOString();
  const toIso = new Date(to).toISOString();

  res.render('battle', {
    title: anchored ? `Battle in ${anchored.system}` : 'Battle report',
    selection,
    kills,
    report,
    chart,
    truncated,
    limit: q.BATTLE_LIMIT,
    systems: await systemsPromise,
    system,
    presets: PRESETS,
    preset: anchored || selection ? null : resolveWindow(req.query).preset,
    anchored,
    contained,
    gapMinutes,
    window: { from: fromIso, to: toIso, fromInput: toInputValue(fromIso), toInput: toInputValue(toIso) },
    duration: formatDuration(to - from),
  });
}));

module.exports = router;
