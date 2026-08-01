# Thunderdome Killboard

A zKillboard-style killboard for a **private** EVE server, built to run on [Render](https://render.com).

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

Set at minimum `ADMIN_PASSWORD` so you can reach `/admin` and paste your first killmail.

```bash
npm test                  # parser + HTTP integration tests
```

## Deploying to Render

The repository ships a `render.yaml` blueprint.

1. Push this repo to GitHub.
2. In Render, **New → Blueprint**, pick the repo, and apply.
3. Set the secret environment variables in the dashboard: `ADMIN_PASSWORD`, and optionally
   `API_KEY` and `SITE_PASSWORD`.

The blueprint provisions a Node web service with a 1 GB persistent disk mounted at `/var/data`,
where the SQLite database lives. **The disk matters** — without it Render's filesystem is
ephemeral and every deploy would wipe the board. Persistent disks require a paid instance type;
the blueprint uses `starter`.

To deploy manually instead of via the blueprint:

| Setting | Value |
| --- | --- |
| Runtime | Node |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check path | `/api/health` |
| Disk mount path | `/var/data` (then set `DATA_DIR=/var/data`) |

## Configuration

| Variable | Purpose |
| --- | --- |
| `DATA_DIR` | Directory for the SQLite database. Point at the mounted disk in production. |
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

## Layout

```
src/
  parser.js      killmail text -> structured data (no I/O)
  db.js          SQLite schema and writes
  queries.js     read queries, stats and leaderboards
  ingest.js      parse + store + queue artwork lookups
  esi.js         ship name -> EVE type ID, cached in SQLite
  auth.js        signed-cookie sessions, admin/site/API gates
  routes/        board, admin, auth, api
  views/         EJS templates
public/          stylesheet and progressive-enhancement JS
test/            parser unit tests and HTTP integration tests
```
