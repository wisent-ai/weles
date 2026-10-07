// FiveSim (5sim.net) topup via Google SSO.
import { WSession } from '../../../dist/session/wsession.js';
import {
  googleSso,
  getGoogleSsoCreds,
} from '../_shared/services/google_sso.mjs';
import { topupOpts } from '../_shared/services/topup_common.mjs';
import {
  humanIdlePause,
  humanClickLocator,
} from '../../../dist/human/mouse.js';
import { popupOrNavigation, urlMatching } from '../_shared/page/settled.mjs';

const { usd } = topupOpts();
// The OAuth round trip lands back on a 5sim.net route other than /login.
const LANDED = /^https:\/\/(www\.)?5sim\.net\/(?!login)/;
const login = await getGoogleSsoCreds();
if (!login) {
  console.log('FAIL: no Google SSO creds');
  process.exit(1);
}

const s = await WSession.start({ label: 'fivesim_topup', browser: 'chromium' });
try {
  await s.goto('https://5sim.net/login');
  const googleButton = s.page
    .locator(
      'button:has-text("Sign in with Google"), a:has-text("Sign in with Google")',
    )
    .and(s.page.locator(':not(:disabled):not([aria-disabled="true"])'))
    .filter({ visible: true })
    .first();
  await googleButton.waitFor({ state: 'visible' });
  const popup = await popupOrNavigation(s.page, /accounts\.google\.com/, () =>
    humanClickLocator(s.page, googleButton),
  );
  const ok = await googleSso(s, login, {
    originHost: '5sim.net',
    page: popup ?? undefined,
  });
  if (!ok) throw new Error('Google SSO did not complete');

  await urlMatching(s.page, LANDED);
  await s.page
    .goto('https://5sim.net/finance', { waitUntil: 'domcontentloaded' })
    .catch(() => {});
  await humanIdlePause('long');

  const amtIn = s.page
    .locator(
      'input[type="number"], input[name*="amount" i], input[inputmode="numeric"]',
    )
    .filter({ visible: true })
    .first();
  if (await amtIn.isVisible().catch(() => false)) {
    await amtIn.click();
    await amtIn.fill(String(usd));
    console.log(`[trajectory] amount filled: $${usd}`);
  }

  // CONFIRM: Find and click pay button
  const { findAndClickPayButton } = await import(
    '../_shared/services/topup_common.mjs'
  );
  const clicked = await findAndClickPayButton(s.page);
  if (!clicked) {
    console.log('FAIL: could not find pay/checkout button');
    process.exit(1);
  }
  await humanIdlePause('long');
  console.log(`PASS-CHARGED: checkout initiated, url=${s.page.url()}`);
} catch (e) {
  console.error('FAIL:', e);
  process.exitCode = 1;
} finally {
  await s.close();
}
