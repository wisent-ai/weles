// AntiCaptcha topup via Google SSO. The refill page offers fixed amounts as
// buttons; the stated TOPUP_USD must be one of them. An amount the page does
// not offer is refused before anything is charged, instead of charging the
// nearest one. Clicking the amount redirects to Stripe.
import { WSession } from '../../../dist/session/wsession.js';
import {
  googleSso,
  getGoogleSsoCreds,
} from '../_shared/services/google_sso.mjs';
import { topupOpts } from '../_shared/services/topup_common.mjs';
import { pageSettled } from '../_shared/page/settled.mjs';
import { clickDescribed } from '../_shared/page/judged/seen.mjs';
import { CHECKOUT_HOST } from '../stripe/hosted_checkout.mjs';

const { usd: amount } = topupOpts();
console.log(`[trajectory] requested $${amount}`);

const login = await getGoogleSsoCreds();
if (!login)
  throw new Error(
    'ANTICAPTCHA_SSO_CREDENTIALS_ABSENT: no Google SSO login is stored for the Anti-Captcha sign-in',
  );

const s = await WSession.start({
  label: 'anticaptcha_topup',
  browser: 'chromium',
});
try {
  await s.goto('https://anti-captcha.com/clients/entrance/login');
  await pageSettled(s.page);
  await s.page
    .locator(
      'button:has-text("Continue with Google"), a:has-text("Continue with Google")',
    )
    .filter({ visible: true })
    .first()
    .click();
  const ok = await googleSso(s, login, { originHost: 'anti-captcha.com' });
  if (!ok) throw new Error('Google SSO did not complete');

  await pageSettled(s.page);
  await s.page.goto('https://anti-captcha.com/clients/finance/refill', {
    waitUntil: 'networkidle',
  });
  await pageSettled(s.page);

  // Click VISA card to open payment dialog
  await s.page.locator('span.card-cat:has(img[alt="Visa"])').first().click();
  await pageSettled(s.page);

  // The Stripe option's own Select control, found by the vision model rather
  // than by its position among the dialog's buttons; none refuses the run.
  await clickDescribed(
    s.page,
    'the Select button of the Stripe payment option in the open payment dialog',
  );
  await pageSettled(s.page);

  // The amount control whose whole text is the stated amount: a substring
  // match would take "$100" for "$10".
  const exactAmount = new RegExp(
    `^\\s*\\$${String(amount).replace('.', '\\.')}\\s*$`,
  );
  const amountBtn = s.page
    .locator('button, div')
    .filter({ hasText: exactAmount, visible: true })
    .last();
  if (!(await amountBtn.isVisible()))
    throw new Error(
      `the refill page offers no $${amount} amount; nothing was charged`,
    );
  console.log(`[trajectory] found amount button $${amount}`);

  // CONFIRM: Click amount to redirect to Stripe checkout
  console.log(`[trajectory] CONFIRM: clicking $${amount} to proceed to Stripe`);
  await amountBtn.click();
  await pageSettled(s.page);

  // The amount redirects to Stripe's checkout; anything else is not a charge.
  const url = s.page.url();
  if (new URL(url).hostname !== CHECKOUT_HOST)
    throw new Error(
      `clicking $${amount} did not reach Stripe's checkout (now on ${url}); nothing was charged`,
    );
  console.log(
    `PASS-CHARGED-PENDING: redirected to Stripe's checkout (${url}); the $${amount} charge completes there and anticaptcha balance reads the result`,
  );
} finally {
  await s.close();
}
