# RideWithByron.com

Byron Green's personal powersports sales site (Shoals Outdoor Sports — Florence, Alabama). It shows only verified Florence inventory and sends every inquiry straight to Byron. It runs on your own Cloudflare account, next to Torque CRM.

## Put it on Cloudflare (one time)

Everything below is done in the Cloudflare dashboard (dash.cloudflare.com), on the same account as Torque CRM. The site runs as a **Worker** with static assets.

1. **Database.** Create a D1 database named exactly `ridewithbyron` (**Storage & Databases → D1 SQL Database → Create**). Each deploy finds it by that name; there's no ID to copy. The site creates its own tables the first time it runs.
2. **Worker.** Go to **Workers & Pages → Create → Import a repository** and pick **SaveEveryKid/ridewithbyron**.
   - Build command: *(leave empty)*
   - Deploy command: `npx wrangler deploy`

   Every push to `main` deploys by itself.
3. **Password.** After the first deploy, open the **ridewithbyron** Worker, go to **Settings → Variables and Secrets**, and add one secret (type *Secret*):

   | Name | Value |
   |---|---|
   | `ADMIN_PASSWORD` | The password you'll use for the dashboard. Make it long. |

   Secrets take effect right away; nothing needs redeploying. Until it is set, nobody can sign in.
4. **First sync.** Open **https://ridewithbyron.<your-subdomain>.workers.dev/admin**, sign in, and press **Run sync now**. Check the unit count, a few prices and the locations against the dealership site. After that the sync runs by itself every 30 minutes.
5. **Your number.** In **Admin → Content**, enter your direct phone. That turns the Call / Text buttons into one-tap links (until then they open the request form).
6. **Domain.** On the Worker, **Settings → Domains & Routes → Add → Custom domain**: add `www.ridewithbyron.com` and `ridewithbyron.com`. Then add a plain variable `SITE_URL` = `https://www.ridewithbyron.com`. The workers.dev address is automatically kept out of search engines.

### Optional settings

| Name | Type | What it does |
|---|---|---|
| `TORQUE_WEBHOOK_URL`, `TORQUE_API_KEY`, `TORQUE_SIGNING_SECRET` | Secret | Deliver leads to Torque CRM (see `docs/TORQUE-INTEGRATION.md`) |
| `NOTIFY_WEBHOOK_URL` | Secret | Instant alert for each new lead (any service that accepts `{ "text": "…" }`) |
| `GA4_MEASUREMENT_ID`, `GOOGLE_ADS_ID`, `GOOGLE_ADS_LEAD_LABEL`, `META_PIXEL_ID` | Variable | Measurement tags; they load only after a visitor allows them |
| `SYNC_ENABLED` = `false` | Variable | Turn the scheduled sync off |
| `INVENTORY_FEED_URL`, `INVENTORY_FEED_TOKEN` | Secret | Use an authorized dealer feed instead, if one is ever issued |

## What is and isn't connected

| Piece | Status |
|---|---|
| Site, admin dashboard, lead capture | Working — tested in Cloudflare's local runtime and by the test suite |
| Inventory sync from the dealership's site search (the same source Torque uses) | Built and tested against a real sample record. **Not yet run against the live site** — step 4 above is that first run |
| Torque CRM | **Not connected.** Leads are stored and are delivered automatically once the Torque settings exist |
| Byron's phone, Google/Meta tags, testimonials, custom domain | Not set — all optional, all set from the dashboard or Cloudflare |

## How it fits together

```
dealership site search ──► src/sync/engine.js ──► units (D1) ──► pages rendered by the Worker
  (≈5 requests per sync)     src/sync/gate.js = the Florence filter      src/views/*
                             overrides table = your feature / hide / notes (never touched by sync)

visitor form ──► POST /lead ──► leads table ──► Torque (+ optional instant alert), retried until delivered
```

| Path | What |
|---|---|
| `src/worker.js` | Every route, security headers, the scheduled trigger |
| `src/sync/gate.js` | The only place that decides "is this unit Florence, in stock?" |
| `src/sync/search.js` | Reads the dealership's inventory search |
| `src/sync/engine.js` | Applies a sync safely: logs, stale handling, cool-down, pause |
| `src/inventory.js` | The single definition of "publicly visible", plus search and filters |
| `src/leads.js` | Validation, traffic-source attribution, duplicate handling, Torque delivery |
| `public/` | Stylesheet, script, fonts, icon |
| `docs/` | Where inventory comes from and why; the Torque payload |

## Day to day

- **Stop the sync immediately:** Admin → Overview → *Suspend synchronization*.
- **If the dealership site changes or is unreachable:** nothing is deleted. Listings are kept, marked "being re-verified" after 3 hours and hidden after 24. Admin → Sync logs shows what happened.
- **Feature, hide or annotate a unit:** Admin → Inventory. These never alter the synced data.
- **Leads backup:** Admin → Leads → Export CSV.
- **Health check:** `/healthz`.

## Cloudflare plan

Built to fit the free plan in normal use. The one thing to watch is the sync: reading several hundred units in one run is the heaviest job here. If Admin → Overview shows syncs failing with a CPU or time-limit error, the Workers Paid plan ($5/month) removes that limit.

## Working on it

```bash
npm install
npm test          # 17 tests: Florence filter, sync safety, leads, admin, every route
npm run dev       # local copy at http://localhost:8787 (put ADMIN_PASSWORD=... in a .dev.vars file)
```

Before going live, get Shoals Outdoor Sports' OK to show their inventory, photos (loaded from their image server) and name, and confirm the "no doc, set-up or dealer prep fees" wording is current — it can be switched off in Admin → Content.
