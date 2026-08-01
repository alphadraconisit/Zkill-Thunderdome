'use strict';

/**
 * Geometry for the cumulative-damage timeline.
 *
 * Computed on the server so the chart is complete in the HTML — the client
 * script only adds the crosshair and tooltip on top of what is already drawn.
 */

const VIEW_WIDTH = 960;
const PLOT_HEIGHT = 300;
const PAD = { top: 16, right: 92, bottom: 28, left: 56 };

// The band of ship icons under the axis: one marker per ship lost.
const LOSS_SIZE = 26;
const LOSS_GAP = 3;
const LOSS_TOP_GAP = 10;

/** Categorical slots, dark mode, in fixed order. Never cycled. */
const SERIES_COLORS = [
  '#3987e5', // blue
  '#d95926', // orange
  '#199e70', // aqua
  '#c98500', // yellow
  '#d55181', // magenta
  '#008300', // green
];

function niceCeiling(value) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalised = value / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

function yTickValues(max, count = 4) {
  const top = niceCeiling(max);
  const ticks = [];
  for (let i = 0; i <= count; i++) ticks.push(Math.round((top / count) * i));
  return { top, ticks };
}

function compactNumber(n) {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(n));
}

function clockLabel(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * Lays the ship-loss markers out under the axis.
 *
 * Kills seconds apart would sit on top of each other, so markers are packed
 * into lanes: each one takes the first lane whose previous marker has ended.
 * Bunched losses therefore stack upwards, and the height of the stack reads as
 * how fiercely ships were dying at that moment.
 */
function placeLosses(losses, scaleX, plot) {
  const ordered = [...losses].sort((a, b) => a.t - b.t);
  const laneEnds = [];
  const markers = [];

  for (const loss of ordered) {
    const centre = scaleX(loss.t);
    // Keep whole markers inside the plot even for the first and last kill.
    const left = Math.min(
      plot.x + plot.w - LOSS_SIZE,
      Math.max(plot.x, centre - LOSS_SIZE / 2)
    );

    let lane = laneEnds.findIndex((end) => left >= end + LOSS_GAP);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = left + LOSS_SIZE;

    markers.push({ ...loss, x: left, centre, lane });
  }

  return { markers, lanes: laneEnds.length };
}

/**
 * @param {Array} series [{ label, points: [{t, v}] }]
 * @param {Array} losses [{ t, id, ship, victim, time, sideIndex }]
 * @returns null when there is nothing to plot
 */
function damageTimeline(series, losses = []) {
  const withPoints = series.filter((s) => s.points && s.points.length);
  if (withPoints.length === 0) return null;

  const allPoints = withPoints.flatMap((s) => s.points);
  const tMin = Math.min(...allPoints.map((p) => p.t));
  const tMax = Math.max(...allPoints.map((p) => p.t));
  const vMax = Math.max(...allPoints.map((p) => p.v), 1);

  // A battle can be over in one volley; give a zero-width span some room.
  const span = tMax - tMin || 60000;
  const { top, ticks } = yTickValues(vMax);

  const plot = {
    x: PAD.left,
    y: PAD.top,
    w: VIEW_WIDTH - PAD.left - PAD.right,
    h: PLOT_HEIGHT - PAD.top - PAD.bottom,
  };

  const scaleX = (t) => plot.x + ((t - tMin) / span) * plot.w;
  const scaleY = (v) => plot.y + plot.h - (v / top) * plot.h;

  const lines = withPoints.map((s, i) => {
    const coords = s.points.map((p) => ({ x: scaleX(p.t), y: scaleY(p.v), ...p }));
    // Cumulative totals only change at a killmail, so a step path is the honest
    // shape — a straight line between events would imply damage we cannot see.
    let d = '';
    coords.forEach((c, index) => {
      if (index === 0) d += `M${c.x.toFixed(1)},${c.y.toFixed(1)}`;
      else d += `H${c.x.toFixed(1)}V${c.y.toFixed(1)}`;
    });

    const last = coords[coords.length - 1];
    return {
      label: s.label,
      color: SERIES_COLORS[i % SERIES_COLORS.length],
      d,
      total: s.points[s.points.length - 1].v,
      last,
    };
  });

  // One hover column per distinct event time, carrying every series' value.
  const times = [...new Set(allPoints.map((p) => p.t))].sort((a, b) => a - b);
  const columns = times.map((t) => ({
    t,
    x: Math.round(scaleX(t) * 10) / 10,
    label: clockLabel(t),
    values: withPoints.map((s, i) => {
      let value = 0;
      for (const p of s.points) {
        if (p.t <= t) value = p.v;
        else break;
      }
      return { label: s.label, color: SERIES_COLORS[i % SERIES_COLORS.length], value };
    }),
  }));

  const xTickCount = Math.min(6, times.length);
  const xTicks = [];
  for (let i = 0; i < xTickCount; i++) {
    const t = tMin + (span / Math.max(1, xTickCount - 1)) * i;
    xTicks.push({ x: scaleX(t), label: clockLabel(t) });
  }

  const placed = placeLosses(losses, scaleX, plot);
  const laneTop = plot.y + plot.h + PAD.bottom + LOSS_TOP_GAP;
  const lossHeight = placed.lanes ? placed.lanes * (LOSS_SIZE + LOSS_GAP) + LOSS_TOP_GAP : 0;

  return {
    viewWidth: VIEW_WIDTH,
    viewHeight: PLOT_HEIGHT + lossHeight,
    lossSize: LOSS_SIZE,
    losses: placed.markers.map((marker) => ({
      ...marker,
      y: laneTop + marker.lane * (LOSS_SIZE + LOSS_GAP),
    })),
    plot,
    lines,
    columns,
    xTicks,
    yTicks: ticks.map((v) => ({ y: scaleY(v), label: compactNumber(v), value: v })),
  };
}

module.exports = { damageTimeline, compactNumber, SERIES_COLORS, LOSS_SIZE };
