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
if (redirectUrl.protocol !== 'http:' || redirectUrl.hostname !== '127.0.0.1'
    || redirectUrl.port !== '8788' || redirectUrl.pathname !== '/v1/gmail/oauth/callback') {
  throw new Error('AUTHORIZATION_URL must target Skrzynka loopback callback');
}

const creds = await getGoogleSsoCreds(authorizationUrl.searchParams.get('login_hint') || undefined);
const s = await WSession.start({
  label: 'skrzynka_gmail_oauth',
  browser: 'chromium',
  proxy: process.env.PROXY_URL || 'direct',
  persona: generatePersona({ os: 'macos', browser: 'chromium' }),
  userDataDir: process.env.WELES_USER_DATA_DIR,
});

try {
  await s.page.goto(authorizationUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const completed = await googleSso(s, creds, { originHost: '127.0.0.1:8788' }).catch(() => false);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const current = s.page.url();
    if (current.startsWith(redirectUrl.toString())) {
      console.log(JSON.stringify({ ok: true, callback_url: current }));
      process.exitCode = 0;
      break;
    }
    if (!completed && !current.includes('accounts.google.com')) break;
    await s.wait(1).catch(() => {});
  }
  if (!s.page.url().startsWith(redirectUrl.toString())) {
    console.log(JSON.stringify({ ok: false, reason: 'google_oauth_did_not_return', url: s.page.url() }));
    process.exitCode = 2;
  }
} finally {
  await s.close().catch(() => {});
}
