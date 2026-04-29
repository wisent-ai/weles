// Google SSO driver for service-credential balance trajectories.
// Many proxy/captcha/SMS providers expose only a "Sign in with Google" button.
// Caller must already have clicked the provider's "Sign in with Google" button
// and the page must now be on accounts.google.com (or about to redirect there).
import { humanFill } from '../../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';

/**
 * Drive Google's identifier → password → consent sequence.
 * @param {object} session - WSession instance (we use session.page).
 * @param {{ email: string, password: string }} creds
 * @param {{ originHost?: string }} opts - originHost (e.g. "dashboard.iproyal.com") for the post-login redirect check.
 * @returns {Promise<boolean>} true on success, false on detectable failure.
 */
export async function googleSso(session, creds, opts = {}) {
  // If caller passes opts.page (e.g. a popup), drive that page; otherwise the
  // session's main page. Caller is responsible for capturing popups before
  // calling this helper since on('page') listeners attach too late if added
  // here.
  let page = opts.page ?? session.page;
  await page.waitForTimeout(1500);

  for (let i = 0; i < 30; i++) {
    if (/accounts\.google\.com/.test(page.url())) break;
    await page.waitForTimeout(500);
  }
  if (!/accounts\.google\.com/.test(page.url())) {
    console.log(`[google_sso] FAIL: never reached accounts.google.com (url=${page.url()})`);
    return false;
  }

  const emailIn = page.locator('input[type="email"], input[name="identifier"], input#identifierId').filter({ visible: true }).first();
  await emailIn.waitFor({ state: 'visible' });
  await humanFill(page, emailIn, creds.email);
  console.log(`[google_sso] identifier filled (${creds.email})`);

  const idNext = page.locator('#identifierNext button, button:has-text("Next"), [jsname="LgbsSe"]').filter({ visible: true }).first();
  await humanClickLocator(page, idNext);

  // Loop: at each step, try to land on a visible password input. Click
  // "Enter your password" if offered, "Try another way" if we're on the
  // passkey-only page. Up to 6 transitions before giving up.
  let pwInVisible = 0;
  for (let step = 0; step < 6; step++) {
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(500);
      pwInVisible = await page.locator('input[type="password"], input[name="Passwd"]').filter({ visible: true }).count().catch(() => 0);
      if (pwInVisible > 0) break;
    }
    if (pwInVisible > 0) break;

    const enterPw = page.getByText(/^Enter your password$/i).first();
    if (await enterPw.isVisible().catch(() => false)) {
      console.log('[google_sso] clicking "Enter your password"');
      await humanClickLocator(page, enterPw);
      await page.waitForTimeout(1500);
      continue;
    }

    const tryAnother = page.getByText(/^Try another way$/i).first();
    if (await tryAnother.isVisible().catch(() => false)) {
      console.log('[google_sso] clicking "Try another way"');
      await humanClickLocator(page, tryAnother);
      await page.waitForTimeout(1500);
      continue;
    }

    console.log(`[google_sso] no progress option visible (url=${page.url()})`);
    break;
  }

  if (!pwInVisible) {
    console.log(`[google_sso] FAIL: never reached password input (url=${page.url()})`);
    return false;
  }

  const pwIn = page.locator('input[type="password"], input[name="Passwd"]').filter({ visible: true }).first();
  await humanFill(page, pwIn, creds.password);
  console.log('[google_sso] password filled');

  const pwNext = page.locator('#passwordNext button, button:has-text("Next"), [jsname="LgbsSe"]').filter({ visible: true }).first();
  await humanClickLocator(page, pwNext);

  const originHost = opts.originHost;
  const isPopup = page !== session.page;
  for (let i = 0; i < 90; i++) {
    if (isPopup && page.isClosed?.()) {
      console.log('[google_sso] OAuth popup closed; checking main page');
      for (let j = 0; j < 30; j++) {
        await session.page.waitForTimeout(500);
        const u = session.page.url();
        if (originHost && u.includes(originHost) && !/login|signin/i.test(u.split('?')[0])) { console.log(`[google_sso] returned to ${originHost}`); return true; }
      }
      console.log(`[google_sso] popup closed; main page=${session.page.url()}`);
      return true;
    }
    await page.waitForTimeout(1000).catch(() => {});
    if (isPopup && page.isClosed?.()) {
      console.log('[google_sso] OAuth popup closed; checking main page');
      for (let j = 0; j < 20; j++) {
        await session.page.waitForTimeout(500);
        const u = session.page.url();
        if (originHost && u.includes(originHost) && !/login|signin/i.test(u.split('?')[0])) { console.log(`[google_sso] returned to ${originHost}`); return true; }
      }
      console.log(`[google_sso] popup closed; main page=${session.page.url()}`);
      return true;
    }
    const u = page.url();
    // Handle OAuth consent screen — Google asks to confirm scope before redirecting back.
    if (/\/signin\/oauth\/(consent|id)/.test(u)) {
      const continueBtn = page.locator('button:has-text("Continue"), button:has-text("Allow")').filter({ visible: true }).first();
      if (await continueBtn.isVisible().catch(() => false)) {
        console.log('[google_sso] clicking OAuth consent Continue/Allow');
        await humanClickLocator(page, continueBtn).catch(() => {});
        await page.waitForTimeout(2000).catch(() => {});
        continue;
      }
    }
    // For popup mode: only return when the popup ITSELF leaves accounts.google.com (storagerelay redirect or dashboard redirect).
    if (isPopup && originHost && u.includes(originHost) && !/accounts\.google\.com/.test(u)) { console.log(`[google_sso] popup redirected to ${originHost}`); return true; }
    if (!isPopup && originHost && u.includes(originHost)) { console.log(`[google_sso] main page returned to ${originHost}`); return true; }
    if (!isPopup && !/accounts\.google\.com/.test(u)) { console.log(`[google_sso] redirected off google to ${u}`); return true; }
    if (/challenge\/(deviceauth|recaptcha|az|kpe|sk)/.test(u)) {
      console.log(`[google_sso] FAIL: hit Google challenge ${u}`);
      return false;
    }
  }
  console.log(`[google_sso] FAIL: still on google after 90s (${page.url()})`);
  return false;
}

export function parseBalanceFromText(text) {
  if (!text) return null;
  const labeled = text.match(/(?:balance|credit[s]?|account|wallet|funds)[^\n$€£]{0,40}\$([0-9]+(?:\.[0-9]{1,4})?)/i);
  if (labeled) return Number(labeled[1]);
  const dollar = text.match(/\$([0-9]+(?:\.[0-9]{2,4})?)\b/);
  if (dollar) return Number(dollar[1]);
  return null;
}

// Fetch the shared Google account credentials (lukasz.bartoszcze@gmail.com).
// Used by service trajectories whose own row in service_credentials has no
// login_password (per the 'use google sso then' workflow). Picks any row
// whose login_email matches the shared SSO email and login_password is set.
export async function getGoogleSsoCreds(email = 'lukasz.bartoszcze@gmail.com') {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !key) return null;
  const r = await fetch(
    `${supabaseUrl}/rest/v1/service_credentials?login_email=eq.${encodeURIComponent(email)}&login_password=not.is.null&select=login_email,login_password&limit=1`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  );
  if (!r.ok) return null;
  const rows = await r.json();
  const row = rows?.[0];
  if (!row?.login_password) return null;
  return { email: row.login_email, password: row.login_password };
}

export async function patchServiceBalance(displayName, balance) {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !key) return false;
  const r = await fetch(`${supabaseUrl}/rest/v1/service_credentials?display_name=eq.${encodeURIComponent(displayName)}`, {
    method: 'PATCH',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ balance_usd: balance, updated_at: new Date().toISOString() }),
  });
  return r.ok;
}
