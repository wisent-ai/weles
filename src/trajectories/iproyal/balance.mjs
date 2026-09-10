// IPRoyal balance check via Google SSO.
// IPRoyal's "Login with Google" button loads the Google Identity Services (GIS)
// client conditionally; in the weles Chromium build the button is often rendered
// without a working handler and the GIS script never executes. Instead of relying
// on the button, we initiate the OAuth code flow directly with IPRoyal's own
// client_id and redirect_uri, then drive the Google identifier/password sequence
// and let Google redirect back to /social-login/google/success.
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { patchEffectiveBalance } from '../_shared/services/proxy_probe.mjs';
import { humanIdlePause } from '../../../dist/human/mouse.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';

const DASHBOARD_URL = 'https://dashboard.iproyal.com/';
const GOOGLE_OAUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=979254173035-cnuh89fv3k3285biuma7pk77ptup1t9b.apps.googleusercontent.com&redirect_uri=https://dashboard.iproyal.com/social-login/google/success&response_type=code&scope=email%20openid%20profile';

function parseIproyalBalance(text) {
  if (!text) return null;
  const m = text.match(/\$([0-9]+(?:\.[0-9]{1,4})?)\s*Add funds/i);
  return m ? Number(m[1]) : null;
}

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }
console.log(`[trajectory] Using Google SSO: ${login.email}`);

const s = await WSession.start({
  label: 'iproyal_balance',
  browser: 'chromium',
  os: 'windows',
});
try {
  // Start the OAuth code flow directly. This lands on accounts.google.com where
  // the shared googleSso driver can fill the identifier/password.
  await s.page.goto(GOOGLE_OAUTH_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await humanIdlePause('short');

  const ok = await googleSso(s, login, { originHost: 'iproyal.com' });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  // After Google redirects back, the dashboard may land on /me/ or similar.
  // Navigate explicitly to the dashboard root and wait for the balance widget.
  await s.page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await humanIdlePause('long');

  const text = await s.page.evaluate(() => document.body.innerText);
  console.log(`[trajectory] dashboard text length=${text.length}`);
  const balance = parseIproyalBalance(text);
  if (balance == null) {
    const dir = runRecordingsDir('iproyal_balance');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'dashboard-text.txt'), text);
    try { writeFileSync(join(dir, 'dashboard.html'), await s.page.content()); } catch {}
    try { await s.page.screenshot({ path: join(dir, 'dashboard.png'), fullPage: true }); } catch {}
    console.log(`FAIL: IPRoyal balance regex did not match — full dashboard text dumped to ${dir}/`);
    process.exit(1);
  }
  console.log(`[trajectory] balance=$${balance}`);

  const r1 = await patchEffectiveBalance('IPRoyal Residential', balance);
  const r2 = await patchEffectiveBalance('IPRoyal Mobile', balance);
  if (!r1 || !r2) { console.log(`FAIL: PATCH residential=${r1} mobile=${r2}`); process.exit(1); }
  console.log(`PASS: dashboard=$${balance} (effective balance written + probed)`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
