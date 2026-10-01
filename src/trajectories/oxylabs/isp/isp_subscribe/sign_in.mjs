// Signing in to the Oxylabs dashboard through the Google SSO popup.
import { googleSso } from '../../../_shared/services/google_sso.mjs';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { urlMatching } from '../../../_shared/page/settled.mjs';
import { shot } from './evidence.mjs';

export async function signInToDashboard(s, login) {
  await s.page.goto('https://dashboard.oxylabs.io/', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');

  const gsiFrame = s.page.frames().find(f => /gsi\/button/.test(f.url()));
  if (!gsiFrame) { console.log('FAIL: GSI iframe not found'); await shot(s, 'no_gsi'); process.exit(1); }

  const popupPromise = s.page.waitForEvent('popup').catch(() => null);
  await humanClickLocator(gsiFrame, gsiFrame.locator('div[role="button"]').first());
  const popup = await popupPromise;  // allow-raw-playwright: the popup the click produced
  if (!popup) { console.log('FAIL: popup did not open'); process.exit(1); }
  await popup.waitForLoadState('domcontentloaded').catch(() => {});

  const ok = await googleSso(s, login, { originHost: 'oxylabs.io', page: popup });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  await urlMatching(s.page, /^(?!https:\/\/dashboard\.oxylabs\.io\/en\/?(\?.*)?$)/);
  console.log(`[trajectory] post-login url=${s.page.url()}`);
  await shot(s, 'dashboard_home');
}
