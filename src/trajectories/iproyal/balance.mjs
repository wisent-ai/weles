// IPRoyal balance check via Google SSO.
// IPRoyal's "Login with Google" button loads the Google Identity Services (GIS)
// client conditionally; in the weles Chromium build the button is often rendered
// without a working handler and the GIS script never executes. Instead of relying
// on the button, we initiate the OAuth code flow directly with IPRoyal's own
// client_id and redirect_uri, then drive the Google identifier/password sequence
// and let Google redirect back to /social-login/google/success.
import { WSession } from '../../../dist/session/wsession.js';
import {
  googleSso,
  getGoogleSsoCreds,
} from '../_shared/services/google_sso.mjs';
import { patchEffectiveBalance } from '../_shared/services/proxy_probe.mjs';
import { pageSettled } from '../_shared/page/settled.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';

const DASHBOARD_URL = 'https://dashboard.iproyal.com/';
const GOOGLE_OAUTH_URL =
  'https://accounts.google.com/o/oauth2/v2/auth?client_id=979254173035-cnuh89fv3k3285biuma7pk77ptup1t9b.apps.googleusercontent.com&redirect_uri=https://dashboard.iproyal.com/social-login/google/success&response_type=code&scope=email%20openid%20profile';

function parseIproyalBalance(text) {
  if (!text) return null;
  const m = text.match(/\$([0-9]+(?:\.[0-9]{1,4})?)\s*Add funds/i);
  return m ? Number(m[1]) : null;
}

const login = await getGoogleSsoCreds();
if (!login) {
  console.log('FAIL: no Google SSO creds');
  process.exit(1);
}
console.log(`[trajectory] Using Google SSO: ${login.email}`);

const s = await WSession.start({
  label: 'iproyal_balance',
  browser: 'chromium',
  os: 'windows',
});
try {
  // Start the OAuth code flow directly. This lands on accounts.google.com where
  // the shared googleSso driver can fill the identifier/password.
  await s.page.goto(GOOGLE_OAUTH_URL, { waitUntil: 'domcontentloaded' });
  await pageSettled(s.page);

  const ok = await googleSso(s, login, { originHost: 'iproyal.com' });
  if (!ok)
    throw new Error(
      `IPROYAL_SSO_INCOMPLETE: Google sign-in did not complete; observed ${s.page.url()}`,
    );

  // After Google redirects back, the dashboard may land on /me/ or similar.
  // Navigate explicitly to the dashboard root and wait for the balance widget.
  const response = await s.page.goto(DASHBOARD_URL, {
    waitUntil: 'domcontentloaded',
  });
  if (!response)
    throw new Error(`IPROYAL_DASHBOARD_RESPONSE_MISSING: ${s.page.url()}`);
  if (!response.ok())
    throw new Error(
      `IPROYAL_DASHBOARD_HTTP_ERROR: HTTP ${response.status()} at ${response.url()}`,
    );
  const responseError = await response.finished();
  if (responseError)
    throw new Error(`IPROYAL_DASHBOARD_RESPONSE_FAILED: ${response.url()}`, {
      cause: responseError,
    });
  await pageSettled(s.page);

  const text = await s.page.evaluate(() => document.body.innerText);
  console.log(`[trajectory] dashboard text length=${text.length}`);
  const balance = parseIproyalBalance(text);
  if (balance == null) {
    const dir = runRecordingsDir('iproyal_balance');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'dashboard-text.txt'), text);
    try {
      writeFileSync(join(dir, 'dashboard.html'), await s.page.content());
    } catch (error) {
      console.error('IPROYAL_DIAGNOSTIC_HTML_FAILED:', error);
    }
    try {
      await s.page.screenshot({
        path: join(dir, 'dashboard.png'),
        fullPage: true,
      });
    } catch (error) {
      console.error('IPROYAL_DIAGNOSTIC_SCREENSHOT_FAILED:', error);
    }
    throw new Error(
      `IPROYAL_BALANCE_NOT_FOUND: no supported balance widget at ${s.page.url()}; dashboard text saved to ${dir}`,
    );
  }
  console.log(`[trajectory] balance=$${balance}`);

  const r1 = await patchEffectiveBalance('IPRoyal Residential', balance);
  const r2 = await patchEffectiveBalance('IPRoyal Mobile', balance);
  if (!r1 || !r2)
    throw new Error(
      `IPROYAL_BALANCE_NOT_PERSISTED: residential=${r1} mobile=${r2}`,
    );
  console.log(
    `PASS: dashboard=$${balance} (effective balance written + probed)`,
  );
} catch (e) {
  console.error('FAIL:', e);
  process.exitCode = 1;
} finally {
  await s.close();
}
