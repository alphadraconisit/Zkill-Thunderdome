# Thunderdome Killboard

A zKillboard-style killboard for a **private** EVE server, built to run for free on
[Render](https://render.com) with a hosted [Turso](https://turso.tech) database.

Killmails are pasted in exactly the format the server produces — no ESI, no API keys, no
external killmail feed. Paste the text, and the board does the rest: parsing, deduplicating,
indexing, and building per-pilot / corp / alliance / system / ship pages on top of it.

## What it does

- **Paste ingestion.** Drop one or many killmails into the admin form (or POST them to the
  API) and they are parsed into victim, involved parties, destroyed items and dropped items.
- **Kill feed.** Reverse-chronological list with ship render, victim, corp/alliance, system
  with security colouring, pilots involved, damage and time.
- **Kill detail pages.** Victim panel, involved parties ranked by damage with damage bars and
  a final-blow badge, plus destroyed/dropped items grouped by fitting location.
- **Entity pages** for pilots, corporations, alliances, systems and ships, each with
  kills / losses / efficiency, All / Kills / Losses tabs, and side panels for ships flown,
  ships lost and who they fight alongside.
- **Battle detection.** Killmails are clustered into distinct fights by system, time
  proximity and shared participants, and listed on the Battles tab — no manual window
  picking, no model in the loop.
- **Battle reports.** Aggregate any time window (optionally one system) into sides —
  one per alliance — with per-pilot damage dealt and taken and a cumulative damage
  timeline.
- **Search** across every pilot, corp, alliance, system and ship the board has ever seen.
- **Leaderboards** for the last 30 days, falling back to all-time on a quiet board.
- **JSON API** for reading and for automated submission.
- **Private by default options** — password-gate the whole board, or leave it readable and
  gate only submission.

## The killmail format

The parser accepts the standard EVE "copy killmail" text:

```
2026.06.27 15:33:15

Victim: DraconisBeta
Corp: Goat Trading Institute
Alliance: OnlyAlts.
Faction: Unknown
Destroyed: Crane
System: Ahbazon
Security: 0.4
Damage Taken: 5787

Involved parties:

Name: EF Zeta
Security: -10.0
Corp: Endless-Fury
Alliance: Ahbazon-Prime
Faction: None
Ship: Machariel
Weapon: Machariel
Damage Done: 2763

Name: EF Delta (laid the final blow)
...

Destroyed items:

Rocket Launcher II
Gyrostabilizer II, Qty: 4 (Cargo)

Dropped items:

Hecate (Cargo)
Oxygen Isotopes, Qty: 100000 (Cargo)
```

Details the parser handles:

- `(laid the final blow)` marks the final blow and is stripped from the pilot name.
- `Faction: None` / `Alliance: Unknown` become empty rather than literal text.
- Item lines carry an optional `, Qty: N` and an optional `(Cargo)`-style location, which is
  used to group fitted modules separately from cargo.
- Several killmails can be pasted at once — each new mail starts at its own timestamp line.
- Windows (CRLF) pastes are fine.
- **Duplicates are ignored.** Each mail gets a stable hash from its timestamp, victim, ship,
  system, damage and attacker list, so re-pasting the same mail never doubles it up.

A malformed block is reported back with the reason instead of failing the whole paste.

## Running locally

```bash
npm install
cp .env.example .env      # then edit it
npm start                 # http://localhost:3000
```

With `TURSO_DATABASE_URL` left blank, the board writes to a local SQLite file under
`DATA_DIR` — no Turso account needed for development. Set `ADMIN_PASSWORD` so you can reach
`/admin` and paste your first killmail.

```bash
npm test                  # parser, storage and HTTP integration tests
```

## Deploying free on Render + Turso

The board keeps its data in Turso rather than on a local disk, which is what lets it run on
Render's free instance type — Render's filesystem is ephemeral, and disks are a paid feature.

**1. Create the database.** Install the [Turso CLI](https://docs.turso.tech/cli), then:

```bash
turso auth signup
turso db create thunderdome
turso db show thunderdome --url      # -> TURSO_DATABASE_URL
turso db tokens create thunderdome   # -> TURSO_AUTH_TOKEN
```

The schema is created automatically on first boot; there is no migration step to run.

**2. Deploy.** In Render: **New → Blueprint**, pick this repo, apply. Fill in the prompted
variables:

| Variable | Value |
| --- | --- |
| `TURSO_DATABASE_URL` | From `turso db show`. Looks like `libsql://thunderdome-you.turso.io`. |
| `TURSO_AUTH_TOKEN` | From `turso db tokens create`. |
| `ADMIN_PASSWORD` | A strong password — this is how you paste killmails. |
| `API_KEY` | Optional, for automated submission. |
| `SITE_PASSWORD` | **Leave blank for a public board.** Setting it requires a login to read anything. |

**3. Add killmails.** Open `/login`, sign in with `ADMIN_PASSWORD`, then **Submit**.

### What "free" costs you

Render's free instances sleep after about 15 minutes of inactivity, so the first visitor
after a quiet spell waits roughly 30–60 seconds for a cold start. Everyone after that gets
normal speed until it idles again. The data itself is safe across sleeps, restarts and
deploys because it lives in Turso, not on the instance.

Both free tiers are generous relative to a private killboard's traffic, but they are the
providers' to change — worth a glance at current terms before you rely on it.

## Configuration

| Variable | Purpose |
| --- | --- |
| `TURSO_DATABASE_URL` | Hosted libSQL database URL. Blank means "use a local file". |
| `TURSO_AUTH_TOKEN` | Auth token for that database. |
| `DATA_DIR` | Local SQLite directory, used only when `TURSO_DATABASE_URL` is blank. |
| `SESSION_SECRET` | Signs the session cookie. Generate with `openssl rand -hex 32`. |
| `ADMIN_PASSWORD` | Unlocks `/admin` (submitting and deleting). Admin area is disabled if unset. |
| `API_KEY` | Bearer token for `POST /api/killmails`. The write API is disabled if unset. |
| `SITE_PASSWORD` | Optional. When set, the whole board requires a login to read. |
| `BOARD_NAME` | Board name in the header and page titles. |
| `ESI_LOOKUP` | `0` disables ship artwork lookup (see below). |
| `PORT` | Defaults to `3000`; Render sets this for you. |

There are two independent gates, so you can run the board any of three ways:

- **Public board, private submission** — set `ADMIN_PASSWORD` only.
- **Fully private** — also set `SITE_PASSWORD`; nothing is readable without it.
- **Automated feed** — set `API_KEY` and post killmails from your server.

## Battles

The **Battles** tab detects distinct fights automatically and lists them, newest first.
Each card shows the system, EVE-time range, duration, ships lost, participants, damage
and the leading sides, and links straight to that battle's full report.

### How battles are detected

A killmail joins a battle when **all three** hold:

1. it is in the **same system**;
2. it happens within **`gap` minutes** of that battle's latest kill;
3. it shares at least one **pilot, corporation or alliance** with it;
4. the victim has **not already lost a ship** in it.

Rule 3 separates a real engagement from an unrelated gank in the same system
minutes later. Rule 4 is the sharp one: a pilot has one ship to lose, so a second
loss means they went home, re-shipped and came back — a new battle, however close
the clock says it was. **Pods are exempt**: a capsule dies moments after the ship
carrying it, in the same fight, so it is not counted as a second ship. Named
capsule variants (`Capsule - Genolution …`) count as pods too.

The guarantee this buys you: **no detected battle ever contains two ship losses by
the same pilot.**

That is single-link clustering over (system, time, participants) with rule 4 as a
hard boundary. It is deterministic — the same killmails always produce the same
battles — and needs no model, no API key and no network call. A killmail touching
two open battles merges them, which is what happens when skirmishes converge,
unless merging would give some pilot two ship losses.

Two knobs sit above the list:

- **Gap** (default 20 minutes) — the longest quiet stretch that still counts as the
  same fight. Lower it to split long grinding engagements, raise it to join them.
- **Minimum kills** (default 2) — lone killmails are ganks, not battles. Set it to 1
  to see everything.

Fleet size is deliberately **not** a criterion. A rule like "10v10" would discard
both the small skirmishes and the big brawls that bracket it; the participant count
is reported on every battle so you can judge scale yourself.

Detection runs over the selected scan window on each page load, capped at 4000
killmails.

## Battle reports

Reports are **anchored to a battle**, not to a clock. Opening one from the battles
list uses `/battle/report?kill=<id>`, which rebuilds exactly that battle's killmails
— so an evening with three fights in one system gives three separate reports rather
than one merged blur.

The manual form still accepts `?from&to[&system]` for ad-hoc windows. Such a window
may legitimately span several battles; when it does, the report says so and links to
each battle individually.

`/battle/report` takes a time window and turns every killmail inside it into a two-or-more
sided report: damage dealt and taken per side and per pilot, kills, losses, and a
cumulative damage-over-time chart. Deliberately **no ISK anywhere** — a private
server has no market to price hulls against, so damage is the honest currency.

Pick a window with the presets (last hour through last 30 days) or explicit
from/to fields, and optionally narrow to one system. Reports are normally reached by
clicking a detected battle, but the window is always editable. Every kill detail page
also carries a **Battle report** button, which opens the hour either side of that kill
in the same system.

### How sides are worked out

**One side per alliance.** Every pilot flying under the same alliance banner is
one side, and two alliances are never merged into a coalition — if three
alliances are on grid, you get three columns.

Pilots with no alliance fall back to their corporation, and pilots with neither
stand alone. A pilot who appears under different banners across the window is
assigned the one they appeared under most often, so a single mis-typed alliance
on one mail cannot split them in two.

Kills are credited to every side that landed damage on a mail whose victim was on
a different side, so a side that only assisted still shows the kill. Damage dealt
and damage taken are summed from the mails themselves, never inferred.

## Ship artwork

Ship names are matched against EVE type IDs through ESI's `/universe/ids/` endpoint, and the
renders are then served from `images.evetech.net`. This happens in the background after a
killmail is stored — it never blocks a page load or a submission.

If a name cannot be resolved (a custom hull on your server, a typo, or no outbound network at
all), the board falls back to a tinted tile with the ship's initials. Set `ESI_LOOKUP=0` to
skip the lookups entirely and always use the tiles.

## API

```bash
# Submit one or more killmails
curl -X POST https://your-board.onrender.com/api/killmails \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: text/plain" \
  --data-binary @killmail.txt
```

```jsonc
// 201 Created
{
  "created": [{ "id": 1, "victim": "DraconisBeta", "ship": "Crane", "system": "Ahbazon", "url": "/kill/1" }],
  "duplicates": 0,
  "errors": []
}
```

| Endpoint | Description |
| --- | --- |
| `POST /api/killmails` | Submit killmail text. Requires `API_KEY`. |
| `GET /api/killmails?page=1` | Paginated kill feed. |
| `GET /api/killmails/:id` | Full killmail with involved parties and items. |
| `GET /api/stats` | Board totals. |
| `GET /api/health` | Health check — always reachable. |
| `GET /kill/:id/raw` | The original pasted text, verbatim. |

Battle reports are a page (`/battle?from=…&to=…&system=…`), not an API endpoint.

## Layout

```
src/
  parser.js      killmail text -> structured data (no I/O)
  battle.js      side grouping and battle aggregation (no I/O)
  battles.js     battle detection: clusters killmails into distinct fights
  chart.js       server-side SVG geometry for the damage timeline
  db.js          libSQL client, schema, transactional writes
  queries.js     read queries, stats and leaderboards
  ingest.js      parse + store + queue artwork lookups
  esi.js         ship name -> EVE type ID, cached in memory and in the database
  auth.js        signed-cookie sessions, admin/site/API gates
  async.js       async route wrapper so rejections reach the error handler
  routes/        board, admin, auth, api
  views/         EJS templates
public/          stylesheet and progressive-enhancement JS
test/            parser, storage and HTTP integration tests
```

Every database call is async. Templates, however, ask for ship artwork while rendering, so
the `type_ids` table is mirrored in memory at startup and `esi.typeIdFor()` stays
synchronous — see `loadCache()` in `src/esi.js`.
