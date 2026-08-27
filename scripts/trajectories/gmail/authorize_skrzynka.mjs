// Complete Skrzynka's Google OAuth consent on the Weles host and return the
// loopback callback URL for delivery to the Skrzynka process that owns the flow.

import { generatePersona } from '../../../dist/browser/persona.js';
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';

const rawAuthorizationUrl = String(process.env.AUTHORIZATION_URL || '').trim();
const authorizationUrl = new URL(rawAuthorizationUrl);
if (authorizationUrl.protocol !== 'https:' || authorizationUrl.hostname !== 'accounts.google.com') {
  throw new Error('AUTHORIZATION_URL must use https://accounts.google.com');
}
const redirectUrl = new URL(authorizationUrl.searchParams.get('redirect_uri') || '');
const loopbackCallback = redirectUrl.protocol === 'http:' && redirectUrl.hostname === '127.0.0.1'
  && redirectUrl.port === '8788' && redirectUrl.pathname === '/v1/gmail/oauth/callback';
const enterpriseCallback = redirectUrl.protocol === 'https:'
  && redirectUrl.hostname === 'auth.enterprise.wisent.com'
  && redirectUrl.pathname === '/auth/v1/callback';
if (!loopbackCallback && !enterpriseCallback) {
  throw new Error('AUTHORIZATION_URL must target a registered Skrzynka callback');
}

const loginHint = authorizationUrl.searchParams.get('login_hint') || undefined;
const creds = process.env.GOOGLE_EMAIL && process.env.GOOGLE_PASSWORD
  ? {
      email: process.env.GOOGLE_EMAIL,
      password: process.env.GOOGLE_PASSWORD,
      totpSecret: process.env.GOOGLE_TOTP_SECRET || undefined,
    }
  : await getGoogleSsoCreds(loginHint);
if (loginHint && creds.email.toLowerCase() !== loginHint.toLowerCase()) {
  throw new Error('Google credential does not match OAuth login_hint');
}
const s = await WSession.start({
  label: 'skrzynka_gmail_oauth',
  browser: 'chromium',
  proxy: process.env.PROXY_URL || 'direct',
  persona: generatePersona({ os: 'macos', browser: 'chromium' }),
  userDataDir: process.env.WELES_USER_DATA_DIR,
});

let capturedCallback = null;
s.page.on('request', (request) => {
  const requested = request.url();
  if (requested.startsWith(redirectUrl.toString())) capturedCallback = requested;
});

try {
  await s.page.goto(authorizationUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const completed = await googleSso(s, creds, { originHost: redirectUrl.host }).catch(() => false);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const current = s.page.url();
    const callbackUrl = capturedCallback || (current.startsWith(redirectUrl.toString()) ? current : null);
    if (callbackUrl) {
      console.log(JSON.stringify({ ok: true, callback_url: callbackUrl }));
      process.exitCode = 0;
      break;
    }
    if (!completed && !current.includes('accounts.google.com')) break;
    await s.wait(1).catch(() => {});
  }
  if (!capturedCallback && !s.page.url().startsWith(redirectUrl.toString())) {
    console.log(JSON.stringify({ ok: false, reason: 'google_oauth_did_not_return', url: s.page.url() }));
    process.exitCode = 2;
  }
} finally {
  await s.close().catch(() => {});
}
