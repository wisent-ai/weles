// 2Captcha topup. Inherits the login blocker from twocaptcha/balance.mjs —
// 2Captcha's own __wCaptchaDiv gates the Google click.
console.log('FAIL: 2Captcha topup blocked at login. 2Captcha\'s own __wCaptchaDiv (sitekey 88cd55f6a243091cad8cd9c45985a4c7) gates the Google SSO click. Resolve twocaptcha/balance.mjs first; this trajectory inherits the same blocker.');
process.exit(1);
