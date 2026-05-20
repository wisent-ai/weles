// JuicySMS dashboard order-history inspection via Google SSO.
// Same login flow balance.mjs uses (the auto-account is Google-linked,
// not password-secured). After SSO completes, dump the full dashboard
// + every linked sub-page so the user can read which orders the
// dashboard says received SMS.
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { humanIdlePause } from '../../../dist/human/mouse.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOGIN_URL = 'https://juicysms.com/login';
const OUT_DIR = join(process.cwd(), '.work', 'juicysms_dashboard');

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO credentials in DB'); process.exit(1); }
console.log(`[dash] Using Google SSO: ${login.email}`);

const s = await WSession.start({ label: 'juicysms_dashboard', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);
  await humanIdlePause('long');

  let popup = null;
  const popupPromise = s.page.waitForEvent('popup').then(p => { popup = p; }, () => {});
  await s.page.locator('a:has-text("LOGIN WITH GOOGLE"), button:has-text("LOGIN WITH GOOGLE"), a:has-text("Login with Google"), button:has-text("Login with Google")').filter({ visible: true }).first().click();
  await Promise.race([popupPromise, new Promise(r => setTimeout(r, 8000))]);  // allow-raw-playwright: Promise.race deadline matches balance.mjs

  const ok = await googleSso(s, login, { originHost: 'juicysms.com', page: popup });
  if (!ok) throw new Error('google_sso_did_not_complete');

  // Wait until URL settles on juicysms.com (the OAuth roundtrip lands us
  // back on a juicysms route eventually). Earlier check `!/login` exited
  // while still on accounts.google.com, then the next goto raced the
  // OAuth redirect and threw ERR_ABORTED.
  for (let i = 0; i < 60; i++) {
    await humanIdlePause('short');
    if (/juicysms\.com/.test(s.page.url()) && !/\/login/.test(s.page.url())) break;
  }
  console.log(`[dash] post-SSO URL=${s.page.url()}`);
  await humanIdlePause('long');

  mkdirSync(OUT_DIR, { recursive: true });

  // /dashboard is a NotFound component (verified 2026-05-20). The
  // logged-in homepage / "/" / "/my-account" carries the real nav.
  await s.goto('https://juicysms.com/');
  await humanIdlePause('long');
  writeFileSync(join(OUT_DIR, 'home.html'), await s.page.content());
  console.log(`[dash] / rendered url=${s.page.url()}`);

  // Read-only DOM query: extract every in-app nav link, no synthetic events.
  const navHrefs = await s.page.evaluate(`Array.from(document.querySelectorAll('a[href^="/"]')).map(a => a.getAttribute('href')).filter(Boolean)`);  // allow-raw-playwright: read-only href extraction
  const candidates = [...new Set(navHrefs.filter(h => !/^\/(build|favicon|apple|site|lang|blog|faq|hdiw|api|terms|privacy|sitemap|support|referrals|sms-verification|register)/.test(h) && !/\.(png|svg|ico|js|css|webmanifest)/.test(h)))].slice(0, 40);
  console.log(`[dash] in-app routes (post-SSO):`, candidates);
  writeFileSync(join(OUT_DIR, 'nav-candidates.json'), JSON.stringify({ all: navHrefs, candidates }, null, 2));

  for (const path of candidates) {
    const target = path.startsWith('http') ? path : `https://juicysms.com${path}`;
    let errored = false;
    try { await s.goto(target); } catch (e) { errored = true; console.log(`[dash] goto ${path} threw: ${e.message?.slice(0,80)}`); }
    if (errored) continue;
    await humanIdlePause('long');
    const slug = path.replace(/[\/]/g, '_').replace(/^_+|_+$/g, '') || 'root';
    const html = await s.page.content();
    writeFileSync(join(OUT_DIR, `${slug}.html`), html);
    console.log(`[dash] ${path} rendered ${html.length}b`);
  }

  console.log('[dash] PASS');
} catch (e) {
  console.log(`[dash] FAIL: ${e.message?.slice(0, 200)}`);
} finally {
  await s.close();
}
