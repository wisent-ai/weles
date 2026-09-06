// PacketStream topup.
// PacketStream's /dashboard/deposit only offers preset amounts ($50/$100/$250/$500/$1000)
// — TOPUP_USD is rounded UP to the nearest preset.
import { getServiceLogin } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { topupOpts } from '../_shared/services/topup_common.mjs';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const PRESETS = [50, 100, 250, 500, 1000];
const { usd } = topupOpts();
const target = PRESETS.find(p => p >= usd) ?? PRESETS[0];

const login = await getServiceLogin('PacketStream');
if (!login) { console.log('FAIL: no PacketStream creds'); process.exit(1); }

const s = await WSession.start({ label: 'packetstream_topup', browser: 'chromium' });
try {
  await s.goto('https://app.packetstream.io/login');
  await humanIdlePause('short');
  const u = s.page.locator('input[name="username"]').filter({ visible: true }).first();
  await u.click(); await u.pressSequentially(login.email, { delay: 25 });
  const p = s.page.locator('input[name="password"]').filter({ visible: true }).first();
  await p.click(); await p.pressSequentially(login.password, { delay: 25 });
  await p.press('Enter');
  for (let i = 0; i < 20; i++) { await humanIdlePause('short'); if (!/\/login/.test(s.page.url())) break; }

  await s.page.goto('https://app.packetstream.io/dashboard/deposit', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');
  await s.page.selectOption('#paypal-amount', String(target)).catch(() => {});
  console.log(`[trajectory] selected preset $${target} (requested $${usd})`);

  

  // PacketStream's deposit dropdown auto-fires onChange which redirects to PayPal.
  // Trigger the change event explicitly so the redirect fires deterministically.
  await s.page.evaluate((amt) => {
    const sel = document.querySelector('#paypal-amount');
    if (sel) { sel.value = String(amt); sel.dispatchEvent(new Event('change', { bubbles: true })); }
  }, target);
  for (let i = 0; i < 30; i++) {
    await humanIdlePause('short');
    const u = s.page.url();
    if (/paypal\.com|stripe\.com|checkout/i.test(u)) break;
  }
  const finalUrl = s.page.url();
  console.log(`[trajectory] post-submit url=${finalUrl}`);
  if (/paypal\.com|stripe\.com|checkout/i.test(finalUrl)) {
    console.log(`PASS-CHARGED-PENDING: redirected to checkout (${finalUrl}). PayPal/Stripe will complete the $${target} charge against the saved payment method. Verify via PacketStream's "Recent Payments" or by re-running src/trajectories/packetstream/balance.mjs in 1-2 minutes.`);
    process.exit(0);
  }
  console.log(`FAIL: dropdown change did not redirect to a checkout URL (${finalUrl}). PacketStream may have changed its flow; revisit selectors.`);
  process.exit(1);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
