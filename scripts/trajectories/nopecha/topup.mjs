// NopeCHA topup. Inherits the auth blocker from nopecha/balance.mjs —
// auth is browser-extension-bound; /manage shows nothing without an extension session.
console.log('FAIL: NopeCHA topup blocked at auth. NopeCHA\'s authentication is bound to its Chrome extension and /manage exposes "No active keys found" without a stored extension session. Resolve nopecha/balance.mjs first; this trajectory inherits the same blocker.');
process.exit(1);
