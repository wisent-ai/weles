import { WSession } from '../../../dist/session/wsession.js';
import { CaptchaSolver } from '../../../dist/captcha/solver.js';
import {
  injectProviderCookies,
  handleOAuthConsent,
  clickOAuthProviderButton,
} from '../../../dist/platforms/_shared/cross_platform_oauth.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { autoBindCharacter } from '../lib/character-bind.mjs';
import {
  findUsableTwitterAccount,
  stampLinkedTwitter,
  extractPhHandle,
} from './_session.mjs';
import { assertAuthed, AuthProbeError } from '../_shared/auth/auth-probe.mjs';
import { findAccount } from '../_shared/skarbiec/accounts.mjs';

// ProductHunt does not offer email/password signup — only OAuth via Twitter,
// Google, Facebook, AngelList. This trajectory uses an existing Twitter account
// from the Twitter account pool in Skarbiec (inject cookies → OAuth through → onboard).

const URL = 'https://www.producthunt.com/';
const proxy = process.env.PROXY_URL || 'none';
import { pageSettled } from '../_shared/page/settled.mjs';

// findUsableTwitterAccount + stampLinkedTwitter live in _session.mjs.

async function readPage(s) {
  return (
    await s.page
      .evaluate(`(() => {
    var t = (document.body?.innerText ?? '').substring(0, 2000);
    return t;
  })()`)
      .catch(() => '')
  ).toLowerCase();
}

async function signup(s) {
  const twAccount = await findUsableTwitterAccount();
  if (!twAccount) throw new Error('no_twitter_account_in_db');
  const twCookies = twAccount.metadata?.cookies ?? [];
  const twUsername = twAccount.username;
  const twPassword = twAccount.metadata?.password;
  const twEmail = twAccount.metadata?.email;
  const twStatus = twAccount.metadata?.status ?? 'unknown';
  console.log(
    `[ph] using twitter account: ${twUsername} status=${twStatus} (${twCookies.length} cookies)`,
  );
  if (twCookies.length < 2) throw new Error('twitter_account_missing_cookies');

  const injected = await injectProviderCookies(s.ctx, 'twitter', twCookies);
  console.log(
    `[ph] injected ${injected} twitter cookies (x.com + twitter.com)`,
  );

  await s.goto(URL);
  await pageSettled(s.page);

  // Dismiss any cookie consent banner
  const t0 = await readPage(s);
  if (
    t0.includes('cookies') ||
    t0.includes('cookie preferences') ||
    t0.includes('accept')
  ) {
    const r1 = await s.click('Accept all').catch(() => 'no-target-found');
    if (r1 === 'no-target-found')
      await s.click('Accept cookies').catch(() => {});
    await pageSettled(s.page);
    if (s.page.isClosed?.()) throw new Error('page_crashed_on_cookie_dismiss');
  }

  // Open the sign-up modal
  await s.click('Sign up').catch(() => {});
  await s.click('Get started').catch(() => {});
  await pageSettled(s.page);

  // Choose Twitter OAuth. Use accessible-name match so we don't misfire onto
  // adjacent provider buttons (Google/Apple) at larger viewports.
  const t1 = await readPage(s);
  console.log(`[ph] signup modal: ${t1.replace(/\n/g, ' ')}`);
  const twitterLabel =
    /^\s*(Sign in with X|Continue with X|Sign up with Twitter|Continue with Twitter)\s*$/i;
  const clickedTw = await clickOAuthProviderButton(s, twitterLabel);
  if (!clickedTw) {
    await s.click('Continue with Twitter').catch(() => {});
    await s.click('Continue with X').catch(() => {});
    await s.click('Sign up with Twitter').catch(() => {});
  }
  await pageSettled(s.page);

  // If Twitter bounced us to the login page (cookies expired), re-authenticate
  const url1 = s.page.url?.() ?? '';
  const t2 = await readPage(s);
  if (
    (url1.includes('twitter.com') || url1.includes('x.com')) &&
    (t2.includes('sign in') || t2.includes('log in') || t2.includes('password'))
  ) {
    console.log('[ph] re-authenticating with twitter credentials');
    if (!twPassword) throw new Error('twitter_cookies_expired_no_password');
    await s.fill('username', twUsername).catch(() => {});
    await s.fill('email', twEmail ?? twUsername).catch(() => {});
    await pageSettled(s.page);
    await s.click('Next').catch(() => {});
    await pageSettled(s.page);
    await s.fill('password', twPassword);
    await pageSettled(s.page);
    await s.click('Log in').catch(() => {});
    await pageSettled(s.page);
  }

  // OAuth consent screen — ProductHunt asks for Twitter read access
  await handleOAuthConsent(s);

  // ProductHunt onboarding (name, email, interests, notifications): however
  // many steps it shows are walked until the main feed. A page none of the
  // known steps matches is pressed forward; when that leaves it unchanged, it
  // is the failure, named by its URL and text.
  let unknownSeen = null;
  for (;;) {
    if (s.page.isClosed?.()) throw new Error('page_crashed_during_onboarding');
    const url = s.page.url?.() ?? '';
    const t = await readPage(s);
    console.log(`[ph] onboarding: url=${url} text=${t.replace(/\n/g, ' ')}`);

    if (url.includes('twitter.com/login') || url.includes('x.com/login')) {
      throw new Error(`twitter_login_required: ${twUsername}`);
    }

    // ProductHunt gates OAuth sign-ups behind reCAPTCHA v2 at /my/captcha_verification
    if (
      url.includes('/captcha_verification') ||
      t.includes('please, complete') ||
      t.includes('complete the captcha')
    ) {
      console.log(
        '[ph] captcha verification page — extracting sitekey from iframe',
      );
      // Extract sitekey directly from the reCAPTCHA anchor iframe — robust to DOM-order quirks
      const sitekey = await s.page
        .evaluate(`(() => {
        var ifr = document.querySelector('iframe[src*="recaptcha/api2/anchor"]') || document.querySelector('iframe[src*="recaptcha"]');
        if (!ifr) return null;
        var m = (ifr.getAttribute('src') || '').match(/[?&]k=([^&]+)/);
        return m ? m[1] : null;
      })()`)
        .catch(() => null);
      console.log(`[ph] extracted sitekey: ${sitekey}`);
      if (!sitekey) {
        await pageSettled(s.page);
        continue;
      }
      const solver = new CaptchaSolver();
      const token = await solver
        .solveRecaptchaV2(s.page, sitekey)
        .catch((e) => {
          console.log(`[ph] solver threw: ${e.message}`);
          return null;
        });
      if (!token || typeof token !== 'string') {
        console.log(
          `[ph] solver returned no token (${typeof token}: ${token})`,
        );
        throw new Error('recaptcha_solver_no_token');
      }
      console.log(`[ph] got token: ${token.length} chars`);
      const injected = await s.page
        .evaluate(`(() => {
        var token = ${JSON.stringify(token)};
        // Fill every g-recaptcha-response textarea (there may be several — one per widget)
        document.querySelectorAll('textarea[name="g-recaptcha-response"], #g-recaptcha-response').forEach(function(ta) {
          ta.value = token;
          ta.dispatchEvent(new Event('change', { bubbles: true }));
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        });
        // Walk ___grecaptcha_cfg.clients recursively until we find a function-valued "callback"
        var cbCount = 0;
        function walk(o, depth) {
          if (!o || typeof o !== 'object' || depth > 8) return;
          for (var k in o) {
            try {
              var v = o[k];
              if (k === 'callback' && typeof v === 'function') { v(token); cbCount++; }
              else if (v && typeof v === 'object') walk(v, depth + 1);
            } catch (e) {}
          }
        }
        if (window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) walk(window.___grecaptcha_cfg.clients, 0);
        return { cbCount: cbCount, textareas: document.querySelectorAll('textarea[name="g-recaptcha-response"]').length };
      })()`)
        .catch(() => null);
      console.log(
        `[ph] injected token into ${injected?.textareas} textareas, fired ${injected?.cbCount} callbacks`,
      );
      await pageSettled(s.page);
      // ProductHunt's actual submit button is "Verify me!" — and it stays disabled until the reCAPTCHA callback fires
      await s.click('Verify me!').catch(() => {});
      // Force-enable the submit button (ProductHunt leaves it disabled after
      // the reCAPTCHA callback) and then trigger a trusted force-click.
      const submitBtn = s.page.locator('button[type="submit"]').first();
      if (await submitBtn.count()) {
        await submitBtn
          .evaluate((el) => {
            el.disabled = false;
            el.classList.remove('cursor-not-allowed', 'opacity-50');
          })
          .catch(() => {});
        await humanClickLocator(s.page, submitBtn).catch(() => {});
        console.log(`[ph] submit: clicked`);
      } else {
        console.log(`[ph] submit: no-button`);
      }
      await pageSettled(s.page);
      continue;
    }

    if (
      url.match(/producthunt\.com\/?$/) ||
      url.includes('/home') ||
      url.includes('/feed') ||
      t.includes('welcome back')
    ) {
      console.log('[ph] reached main feed');
      break;
    }

    if (
      t.includes('what should we call you') ||
      t.includes('your name') ||
      t.includes('display name')
    ) {
      await s.fill('name', `${twAccount.username}`).catch(() => {});
      await s.click('Continue').catch(() => {});
      await s.click('Next').catch(() => {});
      await pageSettled(s.page);
      continue;
    }
    if (
      t.includes('email') &&
      (t.includes('confirm') ||
        t.includes('verify') ||
        t.includes('enter your email'))
    ) {
      if (twEmail) await s.fill('email', twEmail).catch(() => {});
      await s.click('Continue').catch(() => {});
      await s.click('Next').catch(() => {});
      await pageSettled(s.page);
      continue;
    }
    if (
      t.includes('interests') ||
      t.includes('what topics') ||
      t.includes('follow topics')
    ) {
      await s.click('Skip').catch(() => {});
      await s.click('Continue').catch(() => {});
      await s.click('Next').catch(() => {});
      await pageSettled(s.page);
      continue;
    }
    if (t.includes('notifications') || t.includes('enable notifications')) {
      await s.click('Not now').catch(() => {});
      await s.click('Skip').catch(() => {});
      await pageSettled(s.page);
      continue;
    }
    if (unknownSeen === `${url}\n${t}`)
      throw new Error(
        `producthunt_onboarding_unrecognised: url=${url} text=${t.replace(/\n/g, ' ')}`,
      );
    unknownSeen = `${url}\n${t}`;
    await s.click('Continue').catch(() => {});
    await s.click('Next').catch(() => {});
    await s.click('Done').catch(() => {});
    await pageSettled(s.page);
  }

  const cookies = await s.ctx.cookies().catch(() => []);
  const phAuth = cookies.filter(
    (c) =>
      c.domain?.includes('producthunt.com') &&
      (c.name === '_producthunt_session' ||
        c.name === '_ph' ||
        c.name.includes('session') ||
        c.name.includes('auth')),
  );
  if (phAuth.length < 1) {
    console.log(
      `[ph] no producthunt auth cookies. all: ${cookies
        .filter((c) => c.domain?.includes('producthunt.com'))
        .map((c) => c.name)
        .join(', ')}`,
    );
    throw new Error('no_producthunt_auth_cookies');
  }
  console.log(`[ph] auth cookies: ${phAuth.map((c) => c.name).join(', ')}`);

  // The phAuth check above is too permissive — _producthunt_session_production
  // is set for logged-out visitors too and matches `name.includes('session')`,
  // so its presence does NOT prove authentication. Run a real auth probe.
  try {
    await s.goto(URL);
    await pageSettled(s.page);
    await assertAuthed('producthunt', s, {
      label: 'producthunt_register_post_oauth',
    });
  } catch (probeErr) {
    if (probeErr instanceof AuthProbeError) {
      throw new Error(`oauth_did_not_authenticate: ${probeErr.message}`);
    }
    throw probeErr;
  }

  // Extract the actual PH handle from the topbar user-image-link.
  // Product Hunt's handle can differ from the SSO provider's username.
  // Persist the handle shown by Product Hunt for subsequent profile URLs.
  //
  // Logic moved to _session.mjs#extractPhHandle: bounces between
  // homepage and /my/notifications because PH's homepage often serves
  // the SSR logged-out shell right after OAuth.
  const phHandle = await extractPhHandle(s);
  const phUsername = phHandle ?? twUsername;
  if (phHandle && phHandle !== twUsername) {
    console.log(
      `[ph] platform_handle="${phHandle}" differs from twitter_username="${twUsername}" — using platform_handle`,
    );
  } else if (!phHandle) {
    console.log(
      `[ph] could not extract platform_handle from topbar — falling back to twitter_username="${twUsername}"`,
    );
  }

  // Idempotency guard: if a PH row already exists with this username
  // (because the Twitter SSO source was already linked previously), skip
  // saveAccount so we don't write a duplicate row. PH's OAuth flow always
  // re-authenticates the same PH user when the Twitter account already
  // has a linked PH identity, so a re-run of register.mjs against the same
  // Twitter would otherwise produce N rows pointing at the same PH user.
  const existing = findAccount('producthunt', phUsername);
  if (existing) {
    console.log(
      `[ph] active PH account already exists for username="${phUsername}" id=${existing.id} — skipping saveAccount`,
    );
    return phUsername;
  }

  const result = await s.saveAccount('producthunt', {
    username: phUsername,
    email: twEmail ?? `${twUsername}@wisentmedia.com`,
    password: twPassword ?? 'linked_to_twitter',
  });
  console.log(`[ph] ${result}`);
  await stampLinkedTwitter(phUsername, twUsername).catch((e) =>
    console.log(`[ph] stamp err: ${e.message}`),
  );
  await autoBindCharacter(phUsername, 'producthunt')
    .then((r) => console.log(`[bind] ${JSON.stringify(r)}`))
    .catch((e) => console.log(`[bind] err: ${e.message}`));
  return phUsername;
}

// Single attempt — the prior MAX_RETRIES=5 loop ran the same deterministic
// signup with the same Twitter SSO account, same proxy, and same captcha
// solver on every iteration; if attempt 1 fails (twitter cookies expired,
// captcha unsolvable, account purged) attempts 2-5 fail identically and
// just generate 5x the bot-signal volume against PH's signup endpoint.
// On failure, the worker queues a fresh row on next routine tick.
// The signup interaction uses the browser's configured input path.
const s = await WSession.start({ label: 'producthunt_register', proxy });
try {
  const username = await signup(s);
  console.log(`PASS: ${username}`);
  await s.close();
  process.exit(0);
} catch (e) {
  console.log(`FAIL: ${e.message}`);
  await s.close().catch(() => {});
  process.exit(1);
}
