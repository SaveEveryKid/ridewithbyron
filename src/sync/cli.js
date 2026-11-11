'use strict';
// Manual sync: `npm run sync` (optionally `-- --limit 20`). Useful for cron-style hosting and first-time setup.
const { runSync } = require('./engine');
const i = process.argv.indexOf('--limit');
runSync({ trigger: 'cli', limit: i > -1 ? Number(process.argv[i + 1]) : undefined })
  .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.status === 'failed' || r.status === 'blocked' ? 1 : 0); })
  .catch((e) => { console.error(e); process.exit(1); });
