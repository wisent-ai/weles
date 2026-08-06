// Re-scrape the existing ISP proxy-user's full username and reset its
// password to capture both. Used after isp_create_user.mjs fails to capture
// the auto-suffix Oxylabs appends to the username.

import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getScopedGoogleLogin } from '../_shared/services/google_sso.mjs'
import { spawnSync } from 'node:child_process';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { assertScopedSecretWriter, writeScopedSecretItem } from '../../_shared/scoped-secrets.mjs';


const rand = (n) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
const NEW_PASSWORD = `${rand(8)}Aa1_${rand(3)}`;

assertScopedSecretWriter('oxylabsIsp');
const login = await getScopedGoogleLogin('oxylabsDashboard');
const s = await WSession.start({ label: 'oxylabs_isp_reset', browser: 'chromium' });
try {
  await s.page.goto('https://dashboard.oxylabs.io/', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  const gsiFrame = s.page.frames().find(f => /gsi\/button/.test(f.url()));
  if (!gsiFrame) { console.log('FAIL: no GSI'); process.exit(1); }
  const popupP = s.page.waitForEvent('popup').catch(() => null);
  await humanClickLocator(gsiFrame, gsiFrame.locator('div[role="button"]').first());
  const popup = await Promise.race([popupP, new Promise(r => setTimeout(() => r(null), 15000))]);  // allow-raw-playwright: Promise.race deadline
  await popup?.waitForLoadState('domcontentloaded').catch(() => {});
  if (!await googleSso(s, login, { originHost: 'oxylabs.io', page: popup })) { console.log('FAIL: SSO'); process.exit(1); }
  for (let i = 0; i < 30; i++) { await humanIdlePause('short'); if (!/^https:\/\/dashboard\.oxylabs\.io\/en\/?(\?.*)?$/.test(s.page.url())) break; }

  await s.page.goto('https://dashboard.oxylabs.io/en/overview/ISP', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');

  // 1. Read all visible text — find the existing proxy user name (full, with suffix).
  const text = await s.page.evaluate(() => (document.body && document.body.innerText || '').slice(0, 8000));
  // Look for "wisentisp..." pattern with optional _XXX suffix
  const userMatch = text.match(/\bwisentisp\w+\b/);
  const fullUsername = userMatch ? userMatch[0] : null;

  // Also try to read input[name="username"] / specific fields if present
  const inputs = await s.page.evaluate(() => Array.from(document.querySelectorAll('input')).filter(i => i.offsetParent).map(i => ({ name: i.name, id: i.id, type: i.type, ph: i.placeholder })));
  console.log(`[trajectory] visible input descriptors: ${JSON.stringify(inputs)}`);

  // 2. Click "Generate new password" or similar to refresh credentials.
  const genResult = await s.page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, a')).filter(el => /generate|reset|new password|change password/i.test((el.textContent || '').trim()));
    if (!btns.length) return { ok: false, count: 0 };
    btns[0].scrollIntoView({ block: 'center' });
    btns[0].click();
    return { ok: true, count: btns.length, txt: (btns[0].textContent || '').trim() };
  }).catch(() => ({ ok: false }));
  console.log(`[trajectory] gen-password click: ${JSON.stringify(genResult)}`);
  await humanIdlePause('deliberate');

  // If a password input becomes editable, type the new password.
  const passInputs = await s.page.evaluate(() => Array.from(document.querySelectorAll('input')).filter(i => i.offsetParent && (i.type === 'password' || /password/i.test(i.name + i.id + i.placeholder))).map(i => ({ name: i.name, id: i.id })));
  console.log(`[trajectory] password input count after reset action: ${passInputs.length}`);

  if (passInputs.length > 0) {
    const pwLoc = s.page.locator('input[name="password"], input[type="password"]:not([readonly])').filter({ visible: true }).first();
    if (await pwLoc.isVisible().catch(() => false)) {
      await pwLoc.click({ force: true }).catch(() => {});
      await pwLoc.fill('').catch(() => {});
      await humanType(s.page, NEW_PASSWORD, { delay: 40 });
      console.log(`[trajectory] typed new password (length ${NEW_PASSWORD.length})`);
      // Confirm
      const confirmBtn = s.page.locator('button:has-text("Save"), button:has-text("Confirm"), button:has-text("Update"), button:has-text("Set"), button[type="submit"]').filter({ visible: true }).last();
      if (await confirmBtn.isVisible().catch(() => false)) {
        await confirmBtn.click({ force: true }).catch(() => {});
        await humanIdlePause('long');
      }
    }
  }


  if (fullUsername) {
    writeScopedSecretItem('oxylabsIsp', {
      username: fullUsername,
      password: NEW_PASSWORD,
      host: 'isp.oxylabs.io',
      ports: Array.from(
        { length: Number('10') },
        (_, index) => String(Number('8001') + index),
      ).join(','),
    });
    console.log('[trajectory] stored reset ISP credential through its exact Skarbiec writer');
    // Probe :8001
    const probe = spawnSync('curl', ['-s', '--max-time', '15', '-o', '/dev/null', '-w', '%{http_code}', '-x', `http://${encodeURIComponent(fullUsername)}:${encodeURIComponent(NEW_PASSWORD)}@isp.oxylabs.io:8001`, 'https://lumtest.com/myip.json'], { encoding: 'utf8' });
    console.log(`[trajectory] probe :8001 http=${(probe.stdout || '').trim()}`);
  }
  console.log('[trajectory] done');
} catch (e) {
  console.log(`FAIL: ${e.message}`);
} finally {
  await s.close().catch(() => {});
}
