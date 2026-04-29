// Oxylabs topup. Inherits the login blocker from oxylabs/balance.mjs —
// dashboard.oxylabs.io rejects stored creds and only offers SAML SSO.
console.log('FAIL: Oxylabs topup blocked at login. dashboard.oxylabs.io native form silently rejects stored login_email lukasz.bartoszcze@gmail.com + login_password Warszawa432! and the only SSO option is SAML (not Google). Resolve oxylabs/balance.mjs first; this trajectory inherits the same blocker.');
process.exit(1);
