// Central configuration. Everything comes from the Worker's variables and secrets
// (Cloudflare dashboard → the Worker → Settings → Variables and Secrets). Nothing secret is in code.

const base = () => ({
  siteUrl: 'https://www.ridewithbyron.com',
  isProd: true,
  adminPassword: '',     // secret ADMIN_PASSWORD
  source: {
    // The Florence store's own DX1 website (its pages carry the inventory search setup).
    baseUrl: 'https://www.shoalsoutdoorsportsflorence.com',
    searchConfigPath: '/Inventory/All-Inventory-In-Stock',
    // Authoritative location identifiers used by the source system (see docs/INVENTORY-SOURCE.md):
    florenceLocationName: 'Shoals Outdoor Sports - Florence',
    florenceDealershipId: '12a621fc-062f-42aa-ae9d-b00b0115f412',
    userAgent: 'RideWithByronInventorySync/1.0 (+https://www.ridewithbyron.com/about-this-site)',
    intervalMinutes: 30,          // must match the cron in wrangler.jsonc
    staleAfterMinutes: 180,       // show "being re-verified" after this
    hideAfterHours: 24,           // hide unverified units after this
    challengeBackoffMs: 20000,
    challengeCooldownMinutes: 45,
    enabled: true,
    feedUrl: '', feedToken: '',   // authorized dealer feed, if one is ever issued
  },
  torque: { webhookUrl: '', apiKey: '', signingSecret: '', assignee: 'Byron Green' },
  notifyWebhookUrl: '',
  analytics: { ga4: '', googleAds: '', googleAdsLeadLabel: '', metaPixel: '' },
  dealership: {
    name: 'Shoals Outdoor Sports',
    locationName: 'Shoals Outdoor Sports — Florence',
    street: '3516 Florence Blvd',
    city: 'Florence', region: 'AL', zip: '35634',
    mapsUrl: 'https://www.google.com/maps/dir/?api=1&destination=3516+Florence+Blvd+Florence+AL+35634',
    // As published on the Florence dealership site (2026-11-11). Editable in Admin → Content.
    hours: [['Tuesday – Friday', '8:30 AM – 6:00 PM'], ['Saturday', '8:30 AM – 3:00 PM'], ['Sunday – Monday', 'Closed']],
  },
});

export const config = base();

/** Apply the Worker's environment. Called at the start of every request / scheduled run. */
export function initConfig(env = {}, requestUrl) {
  const s = (k, d = '') => (typeof env[k] === 'string' && env[k].trim() ? env[k].trim() : d);
  const fresh = base();
  Object.assign(config, fresh);
  // SITE_URL if set; otherwise whatever address the site is being served from (workers.dev before the domain is attached).
  config.siteUrl = s('SITE_URL', requestUrl ? new URL(requestUrl).origin : fresh.siteUrl).replace(/\/$/, '');
  config.isProd = !/^http:\/\/(localhost|127\.0\.0\.1)/.test(config.siteUrl);
  config.adminPassword = s('ADMIN_PASSWORD');
  const src = config.source;
  src.baseUrl = s('SOURCE_BASE_URL', src.baseUrl).replace(/\/$/, '');
  src.florenceLocationName = s('SOURCE_FLORENCE_NAME', src.florenceLocationName);
  src.florenceDealershipId = s('SOURCE_FLORENCE_DEALERSHIP_ID', src.florenceDealershipId).toLowerCase();
  src.enabled = s('SYNC_ENABLED', 'true') !== 'false';
  src.feedUrl = s('INVENTORY_FEED_URL');
  src.feedToken = s('INVENTORY_FEED_TOKEN');
  config.torque = { webhookUrl: s('TORQUE_WEBHOOK_URL'), apiKey: s('TORQUE_API_KEY'), signingSecret: s('TORQUE_SIGNING_SECRET'), assignee: s('TORQUE_ASSIGNEE', 'Byron Green') };
  config.notifyWebhookUrl = s('NOTIFY_WEBHOOK_URL');
  config.analytics = { ga4: s('GA4_MEASUREMENT_ID'), googleAds: s('GOOGLE_ADS_ID'), googleAdsLeadLabel: s('GOOGLE_ADS_LEAD_LABEL'), metaPixel: s('META_PIXEL_ID') };
  return config;
}
