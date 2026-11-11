'use strict';
// Central configuration. Every secret comes from the environment (server-side only).
const path = require('path');
const fs = require('fs');

// Minimal .env loader (no dependency). Real deployments should set real env vars.
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const env = (k, d = '') => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const num = (k, d) => (Number.isFinite(Number(env(k, ''))) && env(k, '') !== '' ? Number(env(k)) : d);

const config = {
  port: num('PORT', 3000),
  isProd: env('NODE_ENV') === 'production',
  siteUrl: env('SITE_URL', 'https://www.ridewithbyron.com').replace(/\/$/, ''),
  dbPath: env('DB_PATH', path.join(__dirname, '..', 'data', 'rwb.sqlite')),
  sessionSecret: env('SESSION_SECRET'),
  adminPasswordHash: env('ADMIN_PASSWORD_HASH'), // created with `npm run hash-password`

  // ---- Inventory source: verified by investigation on 2026-11-11 (see docs/INVENTORY-SOURCE.md)
  source: {
    // The Florence store's own DX1 website. Its sitemap enumerates Florence unit pages.
    baseUrl: env('SOURCE_BASE_URL', 'https://www.shoalsoutdoorsportsflorence.com'),
    // 'search' = dealer-site inventory search (same source Torque uses; ~5 requests per sync).
    // 'pages'  = sitemap + one page per unit (slow; gets challenged by the site's bot protection).
    mode: env('SOURCE_MODE', 'search'),
    searchConfigPath: env('SOURCE_SEARCH_PAGE', '/Inventory/All-Inventory-In-Stock'),
    sitemapPath: '/sitemap.xml',
    // The organization's main site is the one that prints "Available at: <location>" on every unit page
    // (the Florence site omits it), so each unit is verified there by its stable GUID path.
    verifyBaseUrl: env('SOURCE_VERIFY_BASE_URL', 'https://www.shoalsoutdoorsports.com'),
    // Authoritative location identifiers used by the source system (DX1):
    florenceLocationName: env('SOURCE_FLORENCE_NAME', 'Shoals Outdoor Sports - Florence'),
    florenceDealershipId: env('SOURCE_FLORENCE_DEALERSHIP_ID', '12a621fc-062f-42aa-ae9d-b00b0115f412'),
    userAgent: env('SYNC_USER_AGENT', 'RideWithByronInventorySync/1.0 (+https://www.ridewithbyron.com/about-this-site)'),
    requestDelayMs: num('SYNC_REQUEST_DELAY_MS', 10000),  // one request at a time; 10s = the crawl-delay the source's robots.txt sets for crawlers
    maxPagesPerRun: num('SYNC_MAX_PAGES_PER_RUN', 240),    // bounded runs; unfinished work resumes next run
    challengeCooldownMinutes: num('SYNC_CHALLENGE_COOLDOWN_MINUTES', 45),
    intervalMinutes: num('SYNC_INTERVAL_MINUTES', 30),    // target cadence 30–60 min
    recheckOthersHours: num('SYNC_RECHECK_OTHERS_HOURS', 24), // non-Florence / catalog pages rotate slower
    maxOthersPerRun: num('SYNC_MAX_OTHERS_PER_RUN', 40),
    staleAfterMinutes: num('SYNC_STALE_AFTER_MINUTES', 180),  // show "being re-verified" after this
    hideAfterHours: num('SYNC_HIDE_AFTER_HOURS', 24),         // hide unverified units after this
    challengeBackoffMs: num('SYNC_CHALLENGE_BACKOFF_MS', 60000),
    maxConsecutiveErrors: num('SYNC_MAX_CONSECUTIVE_ERRORS', 8),
    enabled: env('SYNC_ENABLED', 'true') !== 'false',
  },

  // ---- Torque CRM (Byron's CRM). Not connected until these are set AND a test delivery succeeds.
  torque: {
    webhookUrl: env('TORQUE_WEBHOOK_URL'),
    apiKey: env('TORQUE_API_KEY'),
    signingSecret: env('TORQUE_SIGNING_SECRET'),
    assignee: env('TORQUE_ASSIGNEE', 'Byron Green'),
  },
  // Optional instant notification webhook (e.g. an SMS/push relay). JSON POST.
  notifyWebhookUrl: env('NOTIFY_WEBHOOK_URL'),

  // ---- Analytics (loaded only after visitor consent, only if set)
  analytics: {
    ga4: env('GA4_MEASUREMENT_ID'),
    googleAds: env('GOOGLE_ADS_ID'),
    googleAdsLeadLabel: env('GOOGLE_ADS_LEAD_LABEL'),
    metaPixel: env('META_PIXEL_ID'),
  },

  dealership: {
    name: 'Shoals Outdoor Sports',
    locationName: 'Shoals Outdoor Sports — Florence',
    street: '3516 Florence Blvd',
    city: 'Florence', region: 'AL', zip: '35634',
    mapsUrl: 'https://www.google.com/maps/dir/?api=1&destination=3516+Florence+Blvd+Florence+AL+35634',
    // Published on the Florence dealership site's structured data (2026-11-11). Editable in admin.
    hours: [['Tuesday – Friday', '8:30 AM – 6:00 PM'], ['Saturday', '8:30 AM – 3:00 PM'], ['Sunday – Monday', 'Closed']],
  },
};

if (!config.sessionSecret) {
  if (config.isProd) throw new Error('SESSION_SECRET is required in production');
  config.sessionSecret = 'dev-only-secret-change-me';
}
module.exports = config;
