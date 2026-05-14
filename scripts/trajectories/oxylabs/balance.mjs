// Oxylabs balance check via Google GSI iframe button + popup-based OAuth.
// One scrape covers BOTH 'Oxylabs Residential' and 'Oxylabs Mobile' rows.
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, parseBalanceFromText, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { patchEffectiveBalance } from '../_shared/services/proxy_probe.mjs';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOGIN_URL = 'https://dashboard.oxylabs.io/';
const BILLING_URL = 'https://dashboard.oxylabs.io/en/billing-plans';

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }
console.log(`[trajectory] Using Google SSO: ${login.email}`);

const s = await WSession.start({ label: 'oxylabs_balance', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);
  await humanIdlePause('long');

  const gsiFrame = s.page.frames().find(f => /gsi\/button/.test(f.url()));
  if (!gsiFrame) { console.log('FAIL: Oxylabs Google GSI iframe not found'); process.exit(1); }

  const popupPromise = s.page.waitForEvent('popup').catch(() => null);
  await humanClickLocator(s.page, gsiFrame.locator('div[role="button"]').first());
  const popup = await Promise.race([popupPromise, new Promise(r => setTimeout(() => r(null), 15000))]);  // allow-raw-playwright: Promise.race deadline
  if (!popup) { console.log('FAIL: Google login popup did not open'); process.exit(1); }
  await popup.waitForLoadState('domcontentloaded').catch(() => {});

  const ok = await googleSso(s, login, { originHost: 'oxylabs.io', page: popup });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  for (let i = 0; i < 60; i++) {
    await humanIdlePause('short');
    const u = s.page.url();
    if (!/^https:\/\/dashboard\.oxylabs\.io\/en\/?(\?.*)?$/.test(u)) break;
  }
  console.log(`[trajectory] post-login url=${s.page.url()}`);

  // Oxylabs uses GB-based prepaid plans, not USD wallets. Click into the
  // active product to see remaining traffic.
  for (const txt of [/Mobile Proxies/i, /Residential/i, /Limits and Spending/i]) {
    const btn = s.page.getByText(txt).first();
    if (await btn.isVisible().catch(() => false)) { await btn.click({ force: true }).catch(() => {}); await humanIdlePause('deliberate'); break; }
  }
  await humanIdlePause('long');

  const text = await s.page.evaluate(() => document.body.innerText);
  console.log(`[trajectory] dashboard text length=${text.length}`);
  // Oxylabs displays remaining GB on the product page. The 2026-05-04 regex
  // only handled "remaining/left/available <number> GB" — Oxylabs's redesigned
  // billing page shows "<number> GB remaining" (label after number), and
  // "<number> GB / <total> GB" pure-fraction format. Try every common layout
  // in priority order, take the first match.
  // retry-allowed: regex-match ladder, not request retry
  const patterns = [
    // Verified live 2026-05-05 against Oxylabs Mobile Proxies dashboard:
    // "Traffic available: 2.8 GB" — the value renders in bold on its own
    // line, so innerText separates label from number with a newline. Use
    // [^0-9]{0,30} (no newline exclusion) so the prefix crosses lines.
    // [^0-9] also prevents the prefix from greedily eating the leading
    // digits of the capture group.
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
    // full innerText, rendered HTML, screenshot to .work/oxylabs_balance/
    // so the regex can be fixed against the real text without rerunning.
    const dir = join(process.cwd(), '.work', 'oxylabs_balance');
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
  if (!r1 || !r2) { console.log(`FAIL: PATCH residential=${r1} mobile=${r2}`); process.exit(1); }
  console.log(`PASS: dashboard=$${balance} (effective balance written + probed)`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
