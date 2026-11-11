# RideWithByron.com

Personal powersports sales site for Byron Green, sales representative at Shoals Outdoor Sports — Florence, Alabama. Shows only verified Florence inventory, and routes every inquiry directly to Byron.

## Run it

```bash
npm install
cp .env.example .env        # fill in SESSION_SECRET and ADMIN_PASSWORD_HASH
npm run hash-password -- "a strong password"
npm start                   # http://localhost:3000   admin: /admin
npm test
```

Node 20+. One process, one SQLite file (`DB_PATH`) — put that file on a persistent disk and back it up (it holds leads). Run exactly **one** instance so only one sync scheduler exists. Put it behind HTTPS (any reverse proxy / PaaS); set `NODE_ENV=production` and `SITE_URL`.

## How it fits together

```
dealership site ──► src/sync/engine.js ──► units (SQLite) ──► server-rendered pages
  sitemap + unit pages   parse.js = parsers + Florence gate       src/views/*
  (or authorized feed)   overrides table = your feature/hide/notes (never touched by sync)

visitor form ──► POST /lead ──► leads table (outbox) ──► Torque webhook (+ optional instant alert)
```

| Path | What |
|---|---|
| `src/sync/parse.js` | Parsers and `classifyUnit` — the only place that decides "is this Florence, in stock?" |
| `src/sync/engine.js` | Scheduled sync, logging, stale handling, challenge cool-down, pause switch |
| `src/sync/feed.js` | Adapter for an authorized DX1/dealer feed (not connected yet) |
| `src/inventory.js` | The single definition of "publicly visible" + search/filters |
| `src/leads.js` | Validation, attribution, dedupe, Torque delivery with retries |
| `src/server.js` | Routes, security headers, rate limits, admin |
| `docs/` | Source investigation, Torque contract |

## Connection status (be honest with yourself about these)

| Integration | Status |
|---|---|
| Florence inventory via public dealership pages | **Working, tested live** — but rate-limited by the dealership's bot protection; see `docs/INVENTORY-SOURCE.md` |
| Authorized inventory feed | **Not connected** — needs the dealership/DX1 to issue one |
| Torque CRM | **Not connected** — needs endpoint + credentials; see `docs/TORQUE-INTEGRATION.md` |
| GA4 / Google Ads / Meta Pixel | **Not connected** — set the IDs in `.env`; tags load only after visitor consent |
| Byron's direct phone | **Not set** — Admin → Content. Until then Call/Text buttons open the request form |

## Operations

* **Suspend sync immediately:** Admin → Overview → *Suspend synchronization* (or `SYNC_ENABLED=false`).
* **Source changed / errors:** runs fail safe — existing listings are kept, flagged stale after 3 h, hidden after 24 h. Check Admin → Sync logs, fix the parser, add a fixture under `test/fixtures`, `npm test`, resume.
* **Anti-bot challenge:** scheduled runs pause 45 min automatically. Recurring challenges mean you need the authorized feed.
* **Manual sync:** Admin → *Run sync now*, or `npm run sync`.
* **Health check:** `GET /healthz`.
* **Leads backup:** Admin → Leads → Export CSV.

## SEO

Unique titles/descriptions/canonicals per page, `Vehicle`/`Product` + breadcrumb structured data on unit pages, `/sitemap.xml` of live units only, `/robots.txt`, eight keyword landing pages (`src/seo.js`). Filtered/sorted/paged inventory views are `noindex` with a canonical to `/inventory`. Sold units 301 to their closest live category.
