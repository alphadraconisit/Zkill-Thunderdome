'use strict';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** All timestamps are stored and displayed as EVE time (UTC). */
function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function formatDateLong(iso) {
  if (!iso) return '';
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 2592000) return `${Math.floor(secs / 86400)}d ago`;
  return `${Math.floor(secs / 2592000)}mo ago`;
}

function num(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-US');
}

/** Security status colouring, matching EVE's own banding. */
function secClass(sec) {
  if (sec == null) return 'sec-unknown';
  if (sec >= 0.5) return 'sec-high';
  if (sec > 0.0) return 'sec-low';
  return 'sec-null';
}

function secText(sec) {
  if (sec == null) return '?';
  return Number(sec).toFixed(1);
}

/** Pilot security status: negative is red, positive is blue-ish. */
function pilotSecClass(sec) {
  if (sec == null) return 'psec-neutral';
  if (sec <= -5) return 'psec-outlaw';
  if (sec < 0) return 'psec-negative';
  if (sec >= 5) return 'psec-positive';
  return 'psec-neutral';
}

function entityUrl(kind, name) {
  if (!name) return null;
  const segment = {
    character: 'character',
    corporation: 'corporation',
    alliance: 'alliance',
    system: 'system',
    ship: 'ship',
  }[kind];
  return segment ? `/${segment}/${encodeURIComponent(name)}` : null;
}

/** Deterministic colour for an entity, used for the fallback avatar tiles. */
function tintFor(name) {
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360} 45% 32%)`;
}

function initials(name) {
  return (name || '?')
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

function pageRange(page, pages, span = 2) {
  const out = [];
  const start = Math.max(1, page - span);
  const end = Math.min(pages, page + span);
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}

function buildQuery(base, overrides) {
  const params = new URLSearchParams(base || {});
  for (const [k, v] of Object.entries(overrides)) {
    if (v == null || v === '') params.delete(k);
    else params.set(k, v);
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

module.exports = {
  formatDate, formatDateLong, timeAgo, num,
  secClass, secText, pilotSecClass,
  entityUrl, tintFor, initials, pageRange, buildQuery,
};
