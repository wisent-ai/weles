// SadCaptcha topup. Inherits the login blocker from sadcaptcha/balance.mjs —
// native form only, service_credentials row has no creds.
console.log('FAIL: SadCaptcha topup blocked at login. sadcaptcha.com offers a native form only (no Google SSO) and the SadCaptcha row in service_credentials has neither login_email nor login_password. Resolve sadcaptcha/balance.mjs first; this trajectory inherits the same blocker.');
process.exit(1);
