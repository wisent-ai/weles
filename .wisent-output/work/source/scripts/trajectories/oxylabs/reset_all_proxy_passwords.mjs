// Reset Oxylabs proxy-user passwords and replace only their exact
// dedicated Skarbiec items. Missing read/write grants block before login.
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getScopedGoogleLogin } from '../_shared/services/google_sso.mjs'
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { assertScopedSecretWriter, readScopedProxy, readScopedSecret, writeScopedSecretItem } from '../../_shared/scoped-secrets.mjs';
import { randomBytes } from 'node:crypto';


function generatePassword() {
  // Oxylabs password rules observed 2026-06-23: allowed special symbols are
  // `_ ~ + =`. Standard base64 can produce `+` and `/`; remove `/` and `=`
  // but keep `+` since it is allowed. Then force uppercase, lowercase, digit,
  // and an allowed symbol at the end so the generated password always passes.
  let base = randomBytes(14).toString('base64').replace(/[/=]/g, '');
  if (!/[+_~=]/.test(base)) base += '+';
  return `${base}Aa1_`;
}

const mobileProxy = readScopedProxy('oxylabsMobile');
const dedicatedIspProxy = {
  ...readScopedProxy('oxylabsDedicatedIsp'),
  host: readScopedSecret('oxylabsDedicatedIsp', 'host'),
  ports: readScopedSecret('oxylabsDedicatedIsp', 'ports'),
};
const ispProxy = {
  ...readScopedProxy('oxylabsIsp'),
  host: readScopedSecret('oxylabsIsp', 'host'),
  ports: readScopedSecret('oxylabsIsp', 'ports'),
};
for (const serviceName of ['oxylabsMobile', 'oxylabsDedicatedIsp', 'oxylabsIsp']) {
  assertScopedSecretWriter(serviceName);
}

const login = await getScopedGoogleLogin('oxylabsDashboard');
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }
console.log(`[reset] Using Google SSO: ${login.email}`);

const s = await WSession.start({ label: 'oxylabs_reset_passwords', browser: 'chromium' });
const results = [];

try {
  await s.goto('https://dashboard.oxylabs.io/');
  await humanIdlePause('long');

  const gsiFrame = s.page.frames().find(f => /gsi\/button/.test(f.url()));
  if (!gsiFrame) { console.log('FAIL: no GSI iframe'); process.exit(1); }
  const popupPromise = s.page.waitForEvent('popup');
  await humanClickLocator(s.page, gsiFrame.locator('div[role="button"]').first());
  const popup = await Promise.race([popupPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('popup-timeout')), 15000))]);
  if (!popup) { console.log('FAIL: popup did not open'); process.exit(1); }
  await popup.waitForLoadState('domcontentloaded');

  const ok = await googleSso(s, login, { originHost: 'oxylabs.io', page: popup });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  for (let i = 0; i < 60; i++) {
    await humanIdlePause('short');
    if (!/^https:\/\/dashboard\.oxylabs\.io\/en\/?(\?.*)?$/.test(s.page.url())) break;
  }
  console.log(`[reset] post-login url=${s.page.url()}`);

  async function resetPassword({ usersUrl, product, serviceName, current }) {
    const username = current.username;
    console.log(`[reset] starting ${product}`);
    try {
      await s.page.goto(usersUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await humanIdlePause('long');

      // Click "Edit user" / "Change password" for the known username.
      const editBtn = s.page.locator('tr').filter({ hasText: username }).locator('button, a').filter({ hasText: /Edit user|Change password/i }).first();
      const editVisible = await editBtn.isVisible().catch(() => false);
      console.log(`[reset] ${product} edit/change visible=${editVisible}`);
      if (!editVisible) {
        results.push({ product, status: 'edit_button_not_found' });
        return;
      }
      await editBtn.waitFor({ state: 'visible', timeout: 15000 });
      await humanClickLocator(s.page, editBtn);
      await humanIdlePause('long');

      // The dashboard renders the password field as either type="password" or
      // type="text" with name="password" (plaintext when showing the generated
      // password). Target the visible password input by name/placeholder.
      const passInput = s.page.locator('input[type="password"], input[type="text"][name="password"], input[placeholder*="password" i]').filter({ visible: true }).first();
      const passVisible = await passInput.isVisible().catch(() => false);
      console.log(`[reset] ${product} password input visible=${passVisible}`);
      if (!passVisible) {
        results.push({ product, status: 'no_password_input' });
        return;
      }

      const newPassword = generatePassword();
      await passInput.fill('');
      await passInput.fill(newPassword);
      await humanIdlePause('short');

      // Save/Submit. The dedicated-ISP modal uses "Change password" / "Submit
      // changes"; the mobile modal uses "Submit changes". Click the last
      // visible submit-ish button, but avoid "Generate password".
      const saveBtn = s.page.locator('button')
        .filter({ hasText: /^(Save|Submit|Update|Confirm|Submit changes|Change password)$/i })
        .filter({ visible: true })
        .last();
      if (await saveBtn.isVisible().catch(() => false)) {
        await saveBtn.click({ force: true }).catch(() => {});
        await humanIdlePause('deliberate');
      }

      // Verify success toast. Oxylabs shows "Success!" + "Your user has been
      // updated successfully!" or "Password changed for user <username>".
      const bodyText = await s.page.evaluate(() => document.body.innerText).catch(() => '');
      const hasSuccess = /success|updated successfully|password changed/i.test(bodyText.slice(0, 3000));
      const hasError = /error|failed|incorrect|invalid|weak password|must contain/i.test(bodyText.slice(0, 3000));
      const status = hasSuccess && !hasError ? 'password_set' : hasError ? 'possible_error' : 'unknown';
      if (status === 'password_set') {
        writeScopedSecretItem(serviceName, { ...current, password: newPassword });
      }
      results.push({ product, status });
      console.log(`[reset] ${product} done status=${status}`);
    } catch (e) {
      console.log(`[reset] ${product} err: ${(e.message || String(e)).slice(0, 150)}`);
      results.push({ product, status: 'error', error: e.message });
    }
  }

  await resetPassword({ usersUrl: 'https://dashboard.oxylabs.io/en/overview/MP/users', product: 'mobile', serviceName: 'oxylabsMobile', current: mobileProxy });
  await resetPassword({ usersUrl: 'https://dashboard.oxylabs.io/en/overview/dedicated-isp/users', product: 'dedicated_isp', serviceName: 'oxylabsDedicatedIsp', current: dedicatedIspProxy });
  await resetPassword({ usersUrl: 'https://dashboard.oxylabs.io/en/overview/ISP/users', product: 'isp', serviceName: 'oxylabsIsp', current: ispProxy });

  console.log('Results:');
  for (const r of results) {
    console.log(`  ${r.product}: ${r.status}`);
  }
} catch (e) {
  console.log('FAIL:', (e.message || String(e)).slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
