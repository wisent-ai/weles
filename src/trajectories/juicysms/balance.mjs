// JuicySMS balance check via Google SSO. juicysms.com/login has
// "LOGIN WITH GOOGLE" button (and Cloudflare Turnstile).
import { WSession } from '../../../dist/session/wsession.js';
import {
  googleSso,
  patchServiceBalance,
  getGoogleSsoCreds,
} from '../_shared/services/google_sso.mjs';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { popupOrNavigation, urlMatching } from '../_shared/page/settled.mjs';
import { openJuicyPage, readJuicyPage } from './page.mjs';

const LOGIN_URL = 'https://juicysms.com/login';
// The OAuth round trip lands back on a juicysms.com route other than /login.
const LANDED = /^https:\/\/(www\.)?juicysms\.com\/(?!login)/;
const DISPLAY_NAME = 'JuicySMS';

const login = await getGoogleSsoCreds();
if (!login) {
  console.log('FAIL: no Google SSO credentials in DB');
  process.exit(1);
}
console.log(`[trajectory] Using Google SSO: ${login.email}`);

const s = await WSession.start({
  label: 'juicysms_balance',
  browser: 'chromium',
});
try {
  await openJuicyPage(s, LOGIN_URL);
  const googleButton = s.page
    .locator(
      'a:has-text("LOGIN WITH GOOGLE"), button:has-text("LOGIN WITH GOOGLE"), a:has-text("Login with Google"), button:has-text("Login with Google")',
    )
    .and(s.page.locator(':not(:disabled):not([aria-disabled="true"])'))
    .filter({ visible: true })
    .first();
  await googleButton.waitFor({ state: 'visible' });
  const popup = await popupOrNavigation(s.page, /accounts\.google\.com/, () =>
    humanClickLocator(s.page, googleButton),
  );

  const ok = await googleSso(s, login, {
    originHost: 'juicysms.com',
    page: popup ?? undefined,
  });
  if (!ok) throw new Error('Google SSO did not complete');

  await urlMatching(s.page, LANDED);
  const response = await openJuicyPage(s, 'https://juicysms.com/myaccount');
  const account = await readJuicyPage(response, 'MyAccount');
  const observedEmail = account.auth?.user?.email;
  if (
    typeof observedEmail !== 'string' ||
    observedEmail.trim().toLowerCase() !== login.email.trim().toLowerCase()
  ) {
    throw Object.assign(
      new Error(
        'JuicySMS account does not match the selected sign-in identity',
      ),
      {
        code: 'JUICYSMS_ACCOUNT_MISMATCH',
        expectedAccount: login.email,
        observedAccount: observedEmail ?? null,
        pageUrl: s.page.url(),
      },
    );
  }
  // MyAccount formats auth.user.balance from EUR using currency.rates.
  // The service record stores USD; never relabel another currency as dollars.
  const raw = account.auth.user.balance;
  const eur =
    typeof raw === 'number' || (typeof raw === 'string' && raw.trim())
      ? Number(raw)
      : NaN;
  const usdRate = account.currency?.rates?.USD;
  if (!Number.isFinite(eur)) {
    throw Object.assign(
      new Error('JuicySMS did not provide a numeric account balance'),
      {
        code: 'JUICYSMS_BALANCE_UNAVAILABLE',
        pageUrl: s.page.url(),
        observedBalance: raw ?? null,
      },
    );
  }
  if (
    typeof usdRate !== 'number' ||
    !Number.isFinite(usdRate) ||
    usdRate <= 0
  ) {
    throw Object.assign(
      new Error('JuicySMS did not provide a usable USD conversion rate'),
      {
        code: 'JUICYSMS_BALANCE_RATE_UNAVAILABLE',
        pageUrl: s.page.url(),
        observedRate: usdRate ?? null,
      },
    );
  }
  const balance = Number((eur * usdRate).toFixed(2));
  if (!Number.isFinite(balance))
    throw Object.assign(new Error('JuicySMS USD balance is not finite'), {
      code: 'JUICYSMS_BALANCE_CONVERSION_INVALID',
      balanceEur: eur,
      usdRate,
    });
  console.log(
    `[trajectory] balance EUR=${eur}, provider USD/EUR=${usdRate}, USD=${balance}`,
  );
  const patched = await patchServiceBalance(DISPLAY_NAME, balance);
  if (!patched)
    throw Object.assign(
      new Error('JuicySMS service balance could not be persisted'),
      {
        code: 'JUICYSMS_BALANCE_PERSIST_FAILED',
        displayName: DISPLAY_NAME,
      },
    );
  console.log(`PASS: balance USD=${balance} (persisted)`);
} catch (e) {
  console.error('FAIL:', e);
  process.exitCode = 1;
} finally {
  await s.close();
}
