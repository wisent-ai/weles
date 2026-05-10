// Bright Data zone enabler. The residential_proxy1 zone exists but is in
// "Disabled" state (toggle off in the dashboard header), causing every CONNECT
// to fail with "client_10002: zone not found". Flip the toggle.

import { getServiceLogin } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso } from '../_shared/services/google_sso.mjs';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const ZONE = process.env.BRIGHTDATA_ZONE || 'residential_proxy1';

const login = await getServiceLogin('Bright Data');
if (!login) { console.log('FAIL: no Bright Data creds'); process.exit(1); }

const s = await WSession.start({ label: 'brightdata_enable_zone', browser: 'chromium' });
try {
  await s.goto('https://brightdata.com/cp/login');
  await humanIdlePause('deliberate');
  await s.page.locator('button:has-text("Log in with Google")').filter({ visible: true }).first().click();
  const ok = await googleSso(s, login, { originHost: 'brightdata.com' });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }
  await humanIdlePause('deliberate');

  // Skip onboarding modal.
  for (const sel of ['button:has-text("Skip")', '[aria-label="Close"]']) {
    const btn = s.page.locator(sel).filter({ visible: true }).first();
    if (await btn.isVisible().catch(() => false)) { await btn.click({ force: true }).catch(() => {}); await humanIdlePause('short'); }
  }

  await s.page.goto(`https://brightdata.com/cp/zones/${ZONE}/access_params`, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');

  // Aggressively dismiss the "What is your role?" onboarding modal that
  // re-appears after navigation. The dialog blocks all clicks until skipped.
  for (let attempt = 0; attempt < 6; attempt++) {
    let dismissed = false;
    for (const sel of [
      'button:has-text("Skip")',
      'div:has-text("Skip")',
      '[role="button"]:has-text("Skip")',
      'text=Skip',
      'button[aria-label="Close"]',
      '[aria-label="Close"]',
    ]) {
      const btn = s.page.locator(sel).filter({ visible: true }).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ force: true }).catch(() => {});
        await humanIdlePause('short');
        dismissed = true;
        console.log(`[trajectory] modal dismissed via ${sel} (attempt ${attempt})`);
        break;
      }
    }
    // Also try Esc.
    await s.page.keyboard.press('Escape').catch(() => {});
    await humanIdlePause('short');
    if (!dismissed) break;
  }

  await s.page.screenshot({ path: 'recordings/brightdata_enable_zone/before.png', fullPage: true }).catch(() => {});

  // The Disabled toggle is in the top-right of the page header. Find by
  // the [role="switch"] that's NOT in any dialog/modal.
  const toggleInfo = await s.page.evaluate(() => {
    const switches = Array.from(document.querySelectorAll('[role="switch"], input[type="checkbox"]'));
    const out = [];
    for (const sw of switches) {
      const inDialog = sw.closest('[role="dialog"], [aria-modal="true"]');
      const rect = sw.getBoundingClientRect();
      const checked = sw.getAttribute('aria-checked') ?? sw.checked;
      out.push({ tag: sw.tagName, checked: String(checked), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), inDialog: !!inDialog });
    }
    return out;
  });
  console.log('[trajectory] switches found:', JSON.stringify(toggleInfo));

  // The header toggle is the topmost INPUT[type=checkbox] outside any dialog.
  // BrightData uses <input type=checkbox> backed by a custom-styled switch
  // (no role="switch" attribute). The locator [role="switch"] missed it.
  const switches = await s.page.locator('input[type="checkbox"]').all();
  let headerSwitch = null;
  let bestY = Infinity;
  for (const sw of switches) {
    const box = await sw.boundingBox().catch(() => null);
    if (!box) continue;
    const inDialog = await sw.evaluate(el => !!el.closest('[role="dialog"], [aria-modal="true"]')).catch(() => false);
    if (inDialog) continue;
    if (box.y < bestY) { bestY = box.y; headerSwitch = sw; }
  }
  if (!headerSwitch) { console.log('FAIL: no header checkbox found'); process.exit(2); }
  // The actual checkbox input is hidden (size 0×0); the visible toggle is
  // a styled wrapper. Click the parent label/wrapper which forwards the click.
  await headerSwitch.evaluate(el => {
    const wrapper = el.closest('label') || el.closest('.toggle, .switch') || el.parentElement;
    (wrapper ?? el).click();
  });
  console.log(`[trajectory] clicked header checkbox wrapper at y=${bestY}`);

  await humanIdlePause('deliberate');

  // Confirm if a dialog asks.
  for (const sel of ['button:has-text("Activate")', 'button:has-text("Enable")', 'button:has-text("Confirm")', 'button:has-text("Yes")']) {
    const btn = s.page.locator(sel).filter({ visible: true }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ force: true }).catch(() => {});
      console.log(`[trajectory] confirmed: ${sel}`);
      await humanIdlePause('deliberate');
      break;
    }
  }

  await s.page.screenshot({ path: 'recordings/brightdata_enable_zone/after.png', fullPage: true }).catch(() => {});

  // Verify enabled.
  const enabledNow = await s.page.evaluate(() => {
    const sw = document.querySelector('[role="switch"]');
    if (!sw) return null;
    return sw.getAttribute('aria-checked');
  });
  console.log(`[trajectory] toggle aria-checked=${enabledNow}`);
  if (enabledNow === 'true') console.log('PASS: zone enabled'); else console.log('WARN: toggle not confirmed enabled — check screenshot');
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
