'use strict';
// Usage: npm run hash-password -- "your strong password"
// Put the printed value in ADMIN_PASSWORD_HASH. The plain password is never stored.
const { hashPassword } = require('./security');
const pw = process.argv[2];
if (!pw || pw.length < 12) { console.error('Provide a password of at least 12 characters.'); process.exit(1); }
console.log(hashPassword(pw));
