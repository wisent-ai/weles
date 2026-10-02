// Oxylabs balance check via Google GSI iframe button + popup-based OAuth.
// One scrape covers BOTH 'Oxylabs Residential' and 'Oxylabs Mobile' rows.
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, parseBalanceFromText, getScopedGoogleLogin } from '../_shared/services/google_sso.mjs'
import { patchEffectiveBalance } from '../_shared/services/proxy_probe.mjs';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
import { reviewUntilClosed, urlMatching } from '../_shared/page/settled.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';

const LOGIN_URL = 'https://dashboard.oxylabs.io/';
const BILLING_URL = 'https://dashboard.oxylabs.io/en/billing-plans';

const login = await getScopedGoogleLogin('oxylabsDashboard');
if (!login) { console.log('FAIL: no Google SSO creds'); throw new Error('no Google SSO creds'); }
console.log(`[trajectory] Using Google SSO: ${login.email}`);

const s = await WSession.start({ label: 'oxylabs_balance', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);
  await humanIdlePause('long');

  const gsiFrame = s.page.frames().find(f => /gsi\/button/.test(f.url()));
  if (!gsiFrame) { console.log('FAIL: Oxylabs Google GSI iframe not found'); throw new Error('Oxylabs Google GSI iframe not found'); }

  const popupPromise = s.page.waitForEvent('popup').catch(() => null);
  await humanClickLocator(s.page, gsiFrame.locator('div[role="button"]').first());
  const popup = await popupPromise;  // allow-raw-playwright: the popup the click produced
  if (!popup) { console.log('FAIL: Google login popup did not open'); throw new Error('Google login popup did not open'); }
  await popup.waitForLoadState('domcontentloaded').catch(() => {});

  const ok = await googleSso(s, login, { originHost: 'oxylabs.io', page: popup });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); throw new Error('Google SSO did not complete'); }

  await urlMatching(s.page, /^(?!https:\/\/dashboard\.oxylabs\.io\/en\/?(\?.*)?$)/);
  console.log(`[trajectory] post-login url=${s.page.url()}`);

  // Oxylabs uses GB-based prepaid plans, not USD wallets. The overview page
  // shows "Traffic available: X GB" for the active mobile/residential plan.
  // Avoid clicking into product-specific tabs (they show "used / total"
  // fractions that are easy to misread as remaining).
  await humanIdlePause('long');

  const text = await s.page.evaluate(() => document.body.innerText);
  console.log(`[trajectory] dashboard text length=${text.length}`);
  // Remaining traffic can appear before or after its label, or as a fraction.
  // Try each supported layout
  // in priority order, take the first match.
  // retry-allowed: regex-match ladder, not request retry
  const patterns = [
    // The overview labels the remaining allowance as "Traffic available".
    // Most specific — try this before the generic labels so we don't grab a
    // usage fraction from a product tab.
    /traffic\s*(?:available|remaining|left)[^0-9]{0,30}([0-9]+(?:\.[0-9]+)?)\s*(?:GB|GiB|gigabytes?)/i,
    // Generic "available/remaining/left X GB" fallback.
    /(?:remaining|left|available)[^0-9]{0,30}([0-9]+(?:\.[0-9]+)?)\s*(?:GB|GiB|gigabytes?)/i,
    // "12.34 GB remaining" / "12 GB left" / "12.34 gigabytes available"
    /([0-9]+(?:\.[0-9]+)?)\s*(?:GB|GiB|gigabytes?)\s+(?:remaining|left|available|of)/i,
    // "Traffic balance: 12.34 GB" / "Plan balance 12 GB"
    /(?:traffic|plan|account)\s+balance[^0-9]{0,30}([0-9]+(?:\.[0-9]+)?)\s*(?:GB|GiB)/i,
    // "12.34 GB / 100 GB" — Oxylabs fraction display, FIRST number is remaining
    /([0-9]+(?:\.[0-9]+)?)\s*(?:GB|GiB)\s*\/\s*[0-9]+(?:\.[0-9]+)?\s*(?:GB|GiB)/i,
  ];
  let balance = null;
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m && m[1]) { balance = Number(m[1]); console.log(`[trajectory] GB remaining=${balance} (pattern=${patterns.indexOf(pat)})`); break; }
  }
  if (balance == null) balance = parseBalanceFromText(text);
  if (balance == null) {
    // Forensic dump on miss — same pattern as nopecha/balance.mjs. Writes
    // full innerText, rendered HTML, screenshot to the per-run recordings dir
    // so the regex can be fixed against the real text without rerunning.
    const dir = runRecordingsDir('oxylabs_balance');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'dashboard-text.txt'), text);
    try {
      const html = await s.page.content();
      writeFileSync(join(dir, 'dashboard.html'), html);
    } catch {}
    try { await s.page.screenshot({ path: join(dir, 'dashboard.png'), fullPage: true }); } catch {}
    const gbIdx = [];
    for (let i = 0; (i = text.toLowerCase().indexOf('gb', i)) >= 0; i++) gbIdx.push(i);
    for (const i of gbIdx.slice(0, 10)) {
      console.log(`[trajectory] GB context @${i}: ${text.slice(Math.max(0, i - 60), i + 20).replace(/\s+/g, ' ')}`);
    }
    throw new Error(`oxylabs_balance_regex_no_match — text dumped to ${dir}/`);
  }
  console.log(`[trajectory] balance=${balance}`);

  // patchEffectiveBalance does a real CONNECT through the upstream — if 407,
  // overrides balance to 0 so cron decisions reflect EFFECTIVE balance.
  const r1 = await patchEffectiveBalance('Oxylabs Residential', balance);
  const r2 = await patchEffectiveBalance('Oxylabs Mobile', balance);
  if (!r1 || !r2) { console.log(`FAIL: PATCH residential=${r1} mobile=${r2}`); throw new Error(`PATCH residential=${r1} mobile=${r2}`); }
  console.log(`PASS: dashboard=$${balance} (effective balance written + probed)`);
} catch (error) {
  console.error('FAIL:', error);
  process.exitCode = 1;
} finally {
  try {
    if (process.env.KEEP_OPEN === '1' && !s.page.isClosed()) {
      console.log('[trajectory] KEEP_OPEN=1 — close the browser window or stop the command to finish review');
      await reviewUntilClosed(s);
    }
  } finally {
    await s.close();
  }
}
