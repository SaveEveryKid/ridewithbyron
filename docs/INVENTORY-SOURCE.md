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

## Integration options, in order of preference

### 1. Authorized DX1 feed — recommended for production (NOT CONNECTED)

Ask Shoals Outdoor Sports management / their DX1 account rep for one of:

* a DX1 inventory export/feed (the kind DX1 syndicates to marketplaces) for the organization, including `DealershipId` and dealership name per unit; **or**
* written permission plus a WAF allow-rule for this site's sync user-agent / server IP.

When a feed URL exists, set `INVENTORY_FEED_URL` (and `INVENTORY_FEED_TOKEN` if needed). `src/sync/feed.js` already maps and gates feed records and is covered by tests; its field mapping may need a small adjustment to the real export format.

### 2. Public-page synchronization — implemented and working, with limits

Florence `sitemap.xml` → the same unit path on the main site → Florence gate. Tested live on 2026-11-11: real Florence units were verified and listed (e.g. stock H902, H814A, U721), Tuscumbia units and catalog pages were excluded.

**The initial load did not finish in testing.** Of ~796 discovered pages, 174 were checked before the dealership's WAF began challenging nearly every request from the test server. The remaining pages are queued and resume automatically.

**Observed limits (important):**

* The WAF intermittently answers `/sitemap.xml` with a JavaScript challenge.
* At one request every 1.5 s, the WAF challenged a unit page after ~160 requests.

The engine never attempts to solve or evade a challenge. It therefore:

* sends an honest user-agent, one request at a time, **10 s apart** (the crawl-delay the site's robots.txt asks of crawlers);
* caps each run (`SYNC_MAX_PAGES_PER_RUN`, default 240) and resumes unfinished work next run;
* re-verifies public units first every run; rotates non-Florence/catalog pages slowly (location changes are still caught);
* on a challenge: retries the sitemap once after 60 s; otherwise ends the run, keeps verified data, and pauses scheduled runs for 45 min (one cycle).

Consequences: the first full pass takes a few hours; steady-state freshness is ~45–60 min **if** the WAF tolerates it. If challenges recur, listings go stale → flagged → hidden after 24 h. That is the safe failure, but it is why option 1 is the real answer.

### 3. Dealer-site inventory search — implemented, default mode, NOT yet tested live

`SOURCE_MODE=search` (`src/sync/search.js`). This is the mechanism Torque CRM's Inventory screen already uses: read one dealer inventory page to get the site's search-only key (scoped to this dealer's unsold units, renewed hourly), then query the site's inventory index. About 5 requests return every unit, each with `DealershipName`.

* Every record passes the same Florence gate: `DealershipName` must equal the Florence name and any dealership id in its photo paths must be the Florence id; otherwise it is excluded or quarantined.
* A unit that leaves the index is hidden on the next sync. Incomplete reads and suspicious drops are refused.
* Covered by automated tests using a real sample record from Torque's repository. **A live run from the build environment was not permitted, so the first real sync must be watched** (Admin → Run sync now → check counts, locations and a few prices against the dealership site).
* Caveat: the key is issued for the dealership's own website search. It is public and read-only, but using it from another service is not a formal agreement — get the dealership's OK, as with photos.
* Not confirmed until that first run: whether this index includes manufacturer catalog entries (they would be quarantined for lacking a stock number), and how rich the spec/description fields are compared with unit pages.

Set `SOURCE_MODE=pages` to fall back to option 2.

## Before production

* Get the dealership's written OK to display its inventory, photos (hot-linked from DX1's CDN) and name on RideWithByron.com.
* Get an authorized feed or a WAF allow-rule (above).
* Confirm the "no doc / set-up / dealer prep fees" statement (published on both dealership sites on 2026-11-11) remains current; it can be switched off in Admin → Content.
