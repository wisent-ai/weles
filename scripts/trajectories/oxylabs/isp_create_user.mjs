// Provision Oxylabs ISP proxy user (one-shot post-subscription step).
//
// After subscribing to ISP Proxies, the dashboard shows a "Create your first
// proxy user" CTA at /overview/ISP. The assigned IPs only authenticate via a
// separate ISP-specific username (not the residential OXYLABS_USERNAME).
// This trajectory:
//   1. Login via Google SSO (existing helper)
//   2. Navigate /overview/ISP, click "Create proxy user"
//   3. Fill username (auto-derive: "wisent-isp-<rand>"), set password
//   4. Save credentials to .work/keeper/oxylabs_isp_creds.json + service_credentials row
//   5. Probe :8001 with the new creds to verify auth works

import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
import { humanType } from '../../../dist/human/keyboard.js';

const OUT_DIR = '.work/keeper/oxylabs_isp_user';
mkdirSync(OUT_DIR, { recursive: true });
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
async function shot(s, label) {
  const fp = `${OUT_DIR}/${stamp()}_${label}.png`;
  await s.page.screenshot({ path: fp, fullPage: false }).catch(() => {});
  console.log(`[shot] ${fp}`);
}

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }

// Generate a username + password for the new ISP proxy user.
// Oxylabs ISP password rules (verified 2026-05-09 from the form's red error):
// must contain at least one of `_ ~ + =`. We use `_` plus alphanumerics.
const rand = (n) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
const ISP_USERNAME = process.env.OXYLABS_ISP_USERNAME || `wisentisp${rand(6)}`;
const ISP_PASSWORD = process.env.OXYLABS_ISP_PASSWORD || `${rand(8)}Aa1_${rand(3)}`;
console.log(`[trajectory] target ISP username=${ISP_USERNAME} (password length=${ISP_PASSWORD.length})`);

const s = await WSession.start({ label: 'oxylabs_isp_user', browser: 'chromium' });
try {
  await s.page.goto('https://dashboard.oxylabs.io/', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  const gsiFrame = s.page.frames().find(f => /gsi\/button/.test(f.url()));
  if (!gsiFrame) { console.log('FAIL: GSI iframe not found'); await shot(s, 'no_gsi'); process.exit(1); }
  const popupPromise = s.page.waitForEvent('popup').catch(() => null);
  await humanClickLocator(gsiFrame, gsiFrame.locator('div[role="button"]').first());
  const popup = await Promise.race([popupPromise, new Promise(r => setTimeout(() => r(null), 15000))]);  // allow-raw-playwright: Promise.race deadline
  if (!popup) { console.log('FAIL: popup did not open'); process.exit(1); }
  await popup.waitForLoadState('domcontentloaded').catch(() => {});
  const ok = await googleSso(s, login, { originHost: 'oxylabs.io', page: popup });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }
  for (let i = 0; i < 30; i++) {
    await humanIdlePause('short');
    if (!/^https:\/\/dashboard\.oxylabs\.io\/en\/?(\?.*)?$/.test(s.page.url())) break;
  }
  console.log(`[trajectory] post-login url=${s.page.url()}`);

  await s.page.goto('https://dashboard.oxylabs.io/en/overview/ISP', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await humanIdlePause('long');
  await shot(s, 'overview_isp');

  // Dismiss "Get fully dedicated IPs from premium providers" upsell promo (covers click area).
  const dismissPromo = await s.page.evaluate(() => {
    // Find the promo bar by text and click its close X.
    const bars = Array.from(document.querySelectorAll('div, section, aside')).filter(el => /Get fully dedicated IPs/i.test(el.textContent || ''));
    for (const b of bars) {
      const x = b.querySelector('button[aria-label="Close" i], button:has(svg)');
      if (x) { (x).click(); return true; }
    }
    return false;
  }).catch(() => false);
  console.log(`[trajectory] promo dismissed=${dismissPromo}`);
  await humanIdlePause('short');

  // Click "Create proxy user" CTA. Try DOM-direct click first (bypasses overlay
  // capture), then fall back to Playwright's locator click.
  const domClickResult = await s.page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, a')).filter(el => /create proxy user/i.test((el.textContent || '').trim()));
    if (!btns.length) return { ok: false, count: 0 };
    btns[0].scrollIntoView({ block: 'center' });
    btns[0].click();
    return { ok: true, count: btns.length, txt: (btns[0].textContent || '').trim() };
  }).catch((e) => ({ ok: false, err: e.message?.slice(0, 60) }));
  console.log(`[trajectory] dom-click createBtn: ${JSON.stringify(domClickResult)}`);
  if (!domClickResult.ok) {
    const createBtn = s.page.locator('button:has-text("Create proxy user"), a:has-text("Create proxy user")').filter({ visible: true }).first();
    if (!(await createBtn.isVisible().catch(() => false))) {
      console.log('FAIL: "Create proxy user" button not visible — may already exist');
      await shot(s, 'no_create_btn');
      const txt = await s.page.evaluate(() => (document.body && document.body.innerText || '').slice(0, 4000));
      writeFileSync(`${OUT_DIR}/${stamp()}_overview_text.txt`, txt);
      process.exit(2);
    }
    await createBtn.click({ force: true }).catch(() => {});
  }
  // Click sometimes opens a slide-in form rather than navigating. Poll until
  // a username-like input appears, up to 25s.
  let inputs = [];
  for (let i = 0; i < 25; i++) {
    await humanIdlePause('short');
    inputs = await s.page.evaluate(() => Array.from(document.querySelectorAll('input')).filter(i => i.offsetParent).map(i => ({ name: i.name, id: i.id, type: i.type, ph: i.placeholder, ac: i.autocomplete })));
    if (inputs.some(i => /user/i.test((i.name||'') + (i.id||'') + (i.ph||'')))) break;
  }
  await shot(s, 'after_create_click');
  console.log(`[trajectory] create-form url=${s.page.url()}`);
  console.log(`[trajectory] visible inputs: ${JSON.stringify(inputs)}`);

  const userSel = 'input[name="username"], input[name="proxyUsername"], input[id*="username" i], input[placeholder*="Username" i]';
  const passSel = 'input[name="password"], input[name="proxyPassword"], input[id*="password" i][type="password"], input[type="password"]';
  const userIn = s.page.locator(userSel).filter({ visible: true }).first();
  const passIn = s.page.locator(passSel).filter({ visible: true }).first();
  if (!(await userIn.isVisible().catch(() => false))) {
    console.log('FAIL: username input not visible');
    await shot(s, 'no_user_input');
    process.exit(2);
  }
  await userIn.click({ force: true }).catch(() => {});
  await userIn.fill('').catch(() => {});
  await humanType(s.page, ISP_USERNAME, { delay: 40 });
  if (await passIn.isVisible().catch(() => false)) {
    await passIn.click({ force: true }).catch(() => {});
    await passIn.fill('').catch(() => {});
    await humanType(s.page, ISP_PASSWORD, { delay: 40 });
  }
  await humanIdlePause('short');
  await shot(s, 'after_fill');

  // Click Create user button.
  const createUserBtn = s.page.locator('button:has-text("Create user"), button[type="submit"]').filter({ visible: true }).last();
  if (!(await createUserBtn.isVisible().catch(() => false))) {
    console.log('FAIL: no Create user button');
    await shot(s, 'no_save_btn');
    process.exit(2);
  }
  await createUserBtn.click({ force: true }).catch(() => {});
  await humanIdlePause('long');
  await shot(s, 'after_save');

  // Read the FULL username from the field (Oxylabs auto-appends a suffix
  // like "_qs6VR" so the real username is e.g. "wisentispxxxxx_qs6VR").
  const fullUsername = await s.page.evaluate(() => {
    const inp = document.querySelector('input[name="subuser_name"]');
    return inp ? inp.value : null;
  }).catch(() => null);
  const finalUsername = fullUsername || ISP_USERNAME;
  console.log(`[trajectory] full username from form: ${finalUsername}`);

  // Persist creds locally.
  writeFileSync('.work/keeper/oxylabs_isp_creds.json', JSON.stringify({
    created_at: new Date().toISOString(),
    username: finalUsername,
    password: ISP_PASSWORD,
    endpoint: 'isp.oxylabs.io',
    ports: Array.from({ length: 10 }, (_, i) => 8001 + i),
  }, null, 2));
  console.log('[trajectory] wrote .work/keeper/oxylabs_isp_creds.json');

  // Probe :8001 with new creds.
  const probe = spawnSync('curl', ['-s', '--max-time', '15', '-x', `http://${encodeURIComponent(finalUsername)}:${encodeURIComponent(ISP_PASSWORD)}@isp.oxylabs.io:8001`, 'https://lumtest.com/myip.json'], { encoding: 'utf8' });
  console.log(`[trajectory] probe :8001 stdout="${(probe.stdout || '').slice(0, 200)}" status=${probe.status}`);

  console.log('[trajectory] done');
} catch (e) {
  console.log(`FAIL: ${e.message}`);
  await shot(s, 'fail');
  process.exit(1);
} finally {
  await s.close().catch(() => {});
}
