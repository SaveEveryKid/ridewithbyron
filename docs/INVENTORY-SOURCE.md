# Inventory source — investigation findings and integration design

Investigated 2026-11-11 by reading public pages only (robots.txt, sitemap, home, listing and unit pages).

## What the dealership site is

| Finding | Evidence |
|---|---|
| Platform is **DX1** (DNN / ASP.NET), hosted on Azure behind **Azure WAF** | `Powered by DX1`, `eprodpod22.dx1app.com`, `x-azure-ref` header |
| One DX1 organization, **four dealership records** | `dealershipPolarisXchangeList` in page config |
| `www.shoalsoutdoorsports.com` is the **Tuscumbia** site (`dealershipId 06fcbe5c-…`) | page config + titles ("Shoals Outdoor Sports - Tuscumbia") |
| The Florence store has **its own DX1 site**: `www.shoalsoutdoorsportsflorence.com` | linked from the main site; title "Shoals Outdoor Sports - Florence" |
| **Florence location identifier: `12a621fc-062f-42aa-ae9d-b00b0115f412`** | It is the Florence site's primary `dealershipId`, and it is embedded in the private photo path of units whose page says "Available at: Shoals Outdoor Sports - Florence" |
| Listing pages are rendered in the browser from an **Algolia** index (`prod_WebSellable`) | `Dx1ShowroomAlgolia` module |
| The Algolia key in the page is a **1-hour secured key minted for DX1's own widget** | decoded key has `validUntil`, pinned `facetFilters` |
| The main site's sitemap does **not** list Florence units | Florence unit GUIDs absent from `shoalsoutdoorsports.com/sitemap.xml` |
| The Florence site's sitemap lists ~800 unit pages, **mixing stocked units with manufacturer catalog pages** | catalog pages have no stock number / availability |
| robots.txt allows crawling (only wish-list/cart disallowed); named crawlers get `Crawl-Delay: 10` | both hosts |

### Location signals — what can and cannot be trusted

**Key subtlety:** the Florence site's own unit pages do *not* print a location line. The main site (`www.shoalsoutdoorsports.com`) does, for every unit in the organization, and serves any unit by its GUID path. So the sync **discovers** units from the Florence sitemap and **verifies** each one on the main site (`SOURCE_VERIFY_BASE_URL`). A page with no location line is quarantined, never assumed.

* ✅ `Available at: <span class="location">Shoals Outdoor Sports - Florence</span>` on each unit page — the dealership's own statement.
* ✅ The DealershipId embedded in the unit's private photo paths (`/products-private/prod/<org>/<DealershipId>/…`).
* ❌ URL slugs (`…-Florence-AL-<guid>` vs `…-Tuscumbia-AL-<guid>`): the **same unit** is served under either slug depending on which site you are on.
* ❌ Page titles: a Florence unit viewed on the main site is titled "…, Tuscumbia AL".
* ❌ Being listed in the Florence sitemap: it includes catalog models and can include other stores' units.

## The Florence gate (src/sync/parse.js → `classifyUnit`)

A unit is public only if **all** hold on its most recent successful check:

1. location name equals `Shoals Outdoor Sports - Florence` (exact, normalized);
2. every DealershipId seen in its photo paths equals the Florence id (stock photos carry none — allowed);
3. it has a stock number, title and manufacturer;
4. availability reads `In Stock`.

Anything else is `other_location`, `catalog`, `unavailable`, or — when evidence is missing or contradictory — `quarantined` (hidden, listed in the admin dashboard). The gate is re-run for every public unit on every sync.

## How the site gets inventory

### In use: the dealership site's own inventory search

`src/sync/search.js` — the same mechanism Torque CRM's Inventory screen uses. Each sync reads one dealer inventory page to get the site's search-only key (scoped to this dealer's unsold units, renewed hourly), then asks the site's inventory index for everything. About 5 requests return every unit, each with `DealershipName`.

* Every record passes the Florence gate above; anything else is excluded or quarantined.
* A unit that leaves the index is hidden on the next sync. Empty, partial or suspiciously small results are refused and nothing changes.
* If the dealer page answers with an anti-bot challenge, the sync retries once after a short pause, then stops and pauses scheduled runs for 45 minutes. It never tries to get around a challenge.
* **Not yet run against the live site.** Tested with a real sample record from Torque's repository. The first live run (Admin → Run sync now) is the real test: check counts, locations and prices.
* Unknown until that run: how rich the description/spec fields are, and whether the index contains manufacturer catalog entries (they would be quarantined for lacking a stock number).
* The key is public and read-only but is issued for the dealership's own website. Get the dealership's OK.

### Tried and retired: reading every unit page

Sitemap → one page per unit. It worked (real Florence units were verified this way on 2026-11-11) but needs hundreds of requests per sync, and the dealership's Azure WAF challenged it after ~160 requests and then almost immediately. It was removed in the Cloudflare port; the code is in git history.

Two things learned there still matter: the Florence site's own unit pages do not print a location line (the main site does), and URL slugs/titles disagree about location — which is why the gate uses only the record's dealership name and photo-path id.

### Available if ever issued: an authorized DX1 feed

Set `INVENTORY_FEED_URL` (and `INVENTORY_FEED_TOKEN`). `src/sync/feed.js` maps and gates feed records; its field mapping may need a small adjustment to the real export format. This remains the most durable option.

## Before production

* Get the dealership's written OK to display its inventory, photos (hot-linked from DX1's CDN) and name on RideWithByron.com.
* Get an authorized feed or a WAF allow-rule (above).
* Confirm the "no doc / set-up / dealer prep fees" statement (published on both dealership sites on 2026-11-11) remains current; it can be switched off in Admin → Content.
