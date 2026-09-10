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

  // /dashboard and /orders return 404 (verified 2026-05-20). Real in-app
  // routes from the Ziggy table: /myorders (SMS order history), /myaccount
  // (profile + settings), /addfunds (top-up history), /hire-panel (active
  // hire contracts). The marketing-nav regex on / missed these because
  // they only appear in the logged-in user-menu dropdown.
  async function dumpPath(path) {
    try { await s.goto(`https://juicysms.com${path}`); } catch (e) {
      console.log(`[dash] goto ${path} threw: ${e.message?.slice(0,80)}`);
      return;
    }
    await humanIdlePause('long');
    const slug = path === '/' ? 'home' : path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const html = await s.page.content();
    writeFileSync(join(OUT_DIR, `${slug}.html`), html);
    console.log(`[dash] ${path} rendered ${html.length}b at url=${s.page.url()}`);
  }

  await dumpPath('/');
  await dumpPath('/myaccount');
  await dumpPath('/addfunds');
  await dumpPath('/hire-panel');
  await dumpPath('/webhooks');
  // Paginate /myorders so we capture the full 494-order history. Without
  // paging we only see the most recent 10 (all CANCELLED), missing any
  // earlier order that actually delivered an SMS body. Inertia returns
  // JSON when X-Inertia header is set, so we fetch all pages in-browser
  // and write a single aggregate file (avoids 50 HTML dumps).
  await s.goto('https://juicysms.com/myorders');
  await humanIdlePause('long');
  const allOrders = await s.page.evaluate(async (lastPage) => {  // allow-raw-playwright: read-only fetch loop, no synthetic events
    const decode = t => t.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const out = [];
    for (let p = 1; p <= lastPage; p++) {
      const r = await fetch(`/myorders?page=${p}`, { credentials: 'include' });
      const html = await r.text();
      const m = html.match(/data-page="([^"]+)"/);
      if (!m) continue;
      const data = JSON.parse(decode(m[1]));
      out.push(...(data.props?.orders?.data || []));
    }
    return out;
  }, 50);
  writeFileSync(join(OUT_DIR, 'all_orders.json'), JSON.stringify(allOrders, null, 2));
  console.log(`[dash] aggregated ${allOrders.length} orders into all_orders.json`);

  console.log('[dash] PASS');
} catch (e) {
  console.log(`[dash] FAIL: ${e.message?.slice(0, 200)}`);
} finally {
  await s.close();
}
