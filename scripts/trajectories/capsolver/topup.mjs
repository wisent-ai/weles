// Capsolver topup. Inherits the login blocker from capsolver/balance.mjs —
// Cloudflare Turnstile rejects our session at the Google SSO click.
console.log('FAIL: Capsolver topup blocked at login. Cloudflare Turnstile validates server-side and rejects our session\'s click on the Google button. Resolve capsolver/balance.mjs first; this trajectory inherits the same blocker.');
process.exit(1);
