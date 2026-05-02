import { WSession } from '../../../dist/session/wsession.js';
import { CaptchaSolver } from '../../../dist/captcha/solver.js';
import { injectProviderCookies, handleOAuthConsent, clickOAuthProviderButton } from '../../../dist/platforms/_shared/cross_platform_oauth.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { autoBindCharacter } from '../lib/character-bind.mjs';

// ProductHunt does not offer email/password signup — only OAuth via Twitter,
// Google, Facebook, AngelList. This trajectory uses an existing Twitter account
// from the social_accounts table (inject cookies → OAuth through → onboard).

const URL = 'https://www.producthunt.com/';
const USE_BRIGHTDATA = !!process.env.BRIGHTDATA_BROWSER_WS;
const proxy = USE_BRIGHTDATA ? 'none' : (process.env.PROXY_URL || 'none');
const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

async function findUsableTwitterAccount() {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!supabaseUrl || !supabaseKey) return null;
  const res = await fetch(
    `${supabaseUrl}/rest/v1/social_accounts?platform=eq.twitter&is_active=eq.true&select=id,platform,username,metadata&order=created_at.desc&limit=20`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } },
  );
  if (!res.ok) return null;
  const rows = await res.json();
  for (const a of rows) {
    const hasCookies = Array.isArray(a.metadata?.cookies) && a.metadata.cookies.length >= 2;
    const suspended = String(a.metadata?.status ?? '').toLowerCase().includes('suspend');
    const locked = String(a.metadata?.status ?? '').toLowerCase().includes('lock');
    if (hasCookies && !suspended && !locked) return a;
  }
  for (const a of rows) {
    if (Array.isArray(a.metadata?.cookies) && a.metadata.cookies.length >= 2) return a;
  }
  return rows[0] ?? null;
}

async function readPage(s) {
  return (await s.page.evaluate(`(() => {
    var t = (document.body?.innerText ?? '').substring(0, 2000);
    return t;
  })()`).catch(() => '')).toLowerCase();
}

async function signup(s) {
  const twAccount = await findUsableTwitterAccount();
  if (!twAccount) throw new Error('no_twitter_account_in_db');
  const twCookies = twAccount.metadata?.cookies ?? [];
  const twUsername = twAccount.username;
  const twPassword = twAccount.metadata?.password;
  const twEmail = twAccount.metadata?.email;
  const twStatus = twAccount.metadata?.status ?? 'unknown';
  console.log(`[ph] using twitter account: ${twUsername} status=${twStatus} (${twCookies.length} cookies)`);
  if (twCookies.length < 2) throw new Error('twitter_account_missing_cookies');

  const injected = await injectProviderCookies(s.ctx, 'twitter', twCookies);
  console.log(`[ph] injected ${injected} twitter cookies (x.com + twitter.com)`);

  await s.goto(URL);
  await sleep(4);

  // Dismiss any cookie consent banner
  const t0 = await readPage(s);
  if (t0.includes('cookies') || t0.includes('cookie preferences') || t0.includes('accept')) {
    const r1 = await s.click('Accept all').catch(() => 'no-target-found');
    if (r1 === 'no-target-found') await s.click('Accept cookies').catch(() => {});
    await sleep(2);
    if (s.page.isClosed?.()) throw new Error('page_crashed_on_cookie_dismiss');
  }

  // Open the sign-up modal
  await s.click('Sign up').catch(() => {});
  await s.click('Get started').catch(() => {});
  await sleep(3);

  // Choose Twitter OAuth. Use accessible-name match so we don't misfire onto
  // adjacent provider buttons (Google/Apple) at larger viewports.
  const t1 = await readPage(s);
  console.log(`[ph] signup modal: ${t1.slice(0, 120).replace(/\n/g, ' ')}`);
  const twitterLabel = /^\s*(Sign in with X|Continue with X|Sign up with Twitter|Continue with Twitter)\s*$/i;
  const clickedTw = await clickOAuthProviderButton(s, twitterLabel);
  if (!clickedTw) {
    await s.click('Continue with Twitter').catch(() => {});
    await s.click('Continue with X').catch(() => {});
    await s.click('Sign up with Twitter').catch(() => {});
  }
  await sleep(6);

  // If Twitter bounced us to the login page (cookies expired), re-authenticate
  const url1 = s.page.url?.() ?? '';
  const t2 = await readPage(s);
  if ((url1.includes('twitter.com') || url1.includes('x.com')) &&
      (t2.includes('sign in') || t2.includes('log in') || t2.includes('password'))) {
    console.log('[ph] re-authenticating with twitter credentials');
    if (!twPassword) throw new Error('twitter_cookies_expired_no_password');
    await s.fill('username', twUsername).catch(() => {});
    await s.fill('email', twEmail ?? twUsername).catch(() => {});
    await sleep(1);
    await s.click('Next').catch(() => {});
    await sleep(2);
    await s.fill('password', twPassword);
    await sleep(1);
    await s.click('Log in').catch(() => {});
    await sleep(6);
  }

  // OAuth consent screen — ProductHunt asks for Twitter read access
  await handleOAuthConsent(s);

  // ProductHunt onboarding loop (name, email, interests, notifications)
  for (let i = 0; i < 15; i++) {
    if (s.page.isClosed?.()) throw new Error('page_crashed_during_onboarding');
    const url = s.page.url?.() ?? '';
    const t = await readPage(s);
    console.log(`[ph] onboarding ${i}: url=${url.slice(-50)} text=${t.slice(0, 80).replace(/\n/g, ' ')}`);

    if (url.includes('twitter.com/login') || url.includes('x.com/login')) {
      throw new Error(`twitter_login_required: ${twUsername}`);
    }

    // ProductHunt gates OAuth sign-ups behind reCAPTCHA v2 at /my/captcha_verification
    if (url.includes('/captcha_verification') || t.includes('please, complete') || t.includes('complete the captcha')) {
      console.log('[ph] captcha verification page — extracting sitekey from iframe');
      // Extract sitekey directly from the reCAPTCHA anchor iframe — robust to DOM-order quirks
      const sitekey = await s.page.evaluate(`(() => {
        var ifr = document.querySelector('iframe[src*="recaptcha/api2/anchor"]') || document.querySelector('iframe[src*="recaptcha"]');
        if (!ifr) return null;
        var m = (ifr.getAttribute('src') || '').match(/[?&]k=([^&]+)/);
        return m ? m[1] : null;
      })()`).catch(() => null);
      console.log(`[ph] extracted sitekey: ${sitekey}`);
      if (!sitekey) { await sleep(3); continue; }
      const solver = new CaptchaSolver();
      const token = await solver.solveRecaptchaV2(s.page, sitekey).catch((e) => { console.log(`[ph] solver threw: ${e.message?.slice(0, 200)}`); return null; });
      if (!token || typeof token !== 'string') { console.log(`[ph] solver returned no token (${typeof token}: ${token})`); throw new Error('recaptcha_solver_no_token'); }
      console.log(`[ph] got token: ${token.slice(0, 20)}...`);
      const injected = await s.page.evaluate(`(() => {
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
      })()`).catch(() => null);
      console.log(`[ph] injected token into ${injected?.textareas} textareas, fired ${injected?.cbCount} callbacks`);
      await sleep(2);
      // ProductHunt's actual submit button is "Verify me!" — and it stays disabled until the reCAPTCHA callback fires
      await s.click('Verify me!').catch(() => {});
      // Force-enable the submit button (ProductHunt leaves it disabled after
      // the reCAPTCHA callback) and then trigger a trusted force-click.
      const submitBtn = s.page.locator('button[type="submit"]').first();
      if (await submitBtn.count()) {
        await submitBtn.evaluate((el) => { el.disabled = false; el.classList.remove('cursor-not-allowed', 'opacity-50'); }).catch(() => {});
        await humanClickLocator(s.page, submitBtn).catch(() => {});
        console.log(`[ph] submit: clicked`);
      } else { console.log(`[ph] submit: no-button`); }
      await sleep(6);
      continue;
    }

    if (url.match(/producthunt\.com\/?$/) || url.includes('/home') || url.includes('/feed') || t.includes('welcome back')) {
      console.log('[ph] reached main feed');
      break;
    }

    if (t.includes('what should we call you') || t.includes('your name') || t.includes('display name')) {
      await s.fill('name', `${twAccount.username}`).catch(() => {});
      await s.click('Continue').catch(() => {});
      await s.click('Next').catch(() => {});
      await sleep(3);
      continue;
    }
    if (t.includes('email') && (t.includes('confirm') || t.includes('verify') || t.includes('enter your email'))) {
      if (twEmail) await s.fill('email', twEmail).catch(() => {});
      await s.click('Continue').catch(() => {});
      await s.click('Next').catch(() => {});
      await sleep(3);
      continue;
    }
    if (t.includes('interests') || t.includes('what topics') || t.includes('follow topics')) {
      await s.click('Skip').catch(() => {});
      await s.click('Continue').catch(() => {});
      await s.click('Next').catch(() => {});
      await sleep(3);
      continue;
    }
    if (t.includes('notifications') || t.includes('enable notifications')) {
      await s.click('Not now').catch(() => {});
      await s.click('Skip').catch(() => {});
      await sleep(2);
      continue;
    }
    await s.click('Continue').catch(() => {});
    await s.click('Next').catch(() => {});
    await s.click('Done').catch(() => {});
    await sleep(3);
  }

  const cookies = await s.ctx.cookies().catch(() => []);
  const phAuth = cookies.filter(c =>
    c.domain?.includes('producthunt.com') &&
    (c.name === '_producthunt_session' || c.name === '_ph' || c.name.includes('session') || c.name.includes('auth'))
  );
  if (phAuth.length < 1) {
    console.log(`[ph] no producthunt auth cookies. all: ${cookies.filter(c => c.domain?.includes('producthunt.com')).map(c => c.name).join(', ')}`);
    throw new Error('no_producthunt_auth_cookies');
  }
  console.log(`[ph] auth cookies: ${phAuth.map(c => c.name).join(', ')}`);

  // Extract the actual PH handle from the topbar user-image-link.
  // PH issues its own handle distinct from the Twitter SSO username
  // (verified 2026-05-02: SSO via @jannieerdman414805 → PH handle
  // @erdmanjann4145). We must persist PH's handle, not the Twitter one,
  // otherwise every profile_view trajectory navigates to /@<wrong-handle>
  // and benign declares account_missing.
  //
  // The onboarding loop above can dwell on /newsletters?campaign=... or
  // similar marketing pages whose DOM doesn't include the authed topbar.
  // Navigate to the homepage first so the topbar definitely renders.
  await s.goto(URL);
  await sleep(4);
  const phHandle = await s.page.evaluate(() => {
    const link = document.querySelector('a[data-test^="user-image-link-"]') ||
                 document.querySelector('a[href*="/@"][data-test*="user"]');
    const href = link?.getAttribute('href') || '';
    const m = href.match(/\/@([^/?#]+)/);
    return m ? m[1] : null;
  }).catch(() => null);
  const phUsername = phHandle ?? twUsername;
  if (phHandle && phHandle !== twUsername) {
    console.log(`[ph] platform_handle="${phHandle}" differs from twitter_username="${twUsername}" — using platform_handle`);
  } else if (!phHandle) {
    console.log(`[ph] could not extract platform_handle from topbar — falling back to twitter_username="${twUsername}"`);
  }

  // Idempotency guard: if a PH row already exists with this username
  // (because the Twitter SSO source was already linked previously), skip
  // saveAccount so we don't write a duplicate row. PH's OAuth flow always
  // re-authenticates the same PH user when the Twitter account already
  // has a linked PH identity, so a re-run of register.mjs against the same
  // Twitter would otherwise produce N rows pointing at the same PH user.
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (supabaseUrl && supabaseKey) {
    const exists = await fetch(
      `${supabaseUrl}/rest/v1/social_accounts?platform=eq.producthunt&username=eq.${encodeURIComponent(phUsername)}&is_active=eq.true&select=id,username`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } },
    ).then(r => r.ok ? r.json() : []).catch(() => []);
    if (exists.length > 0) {
      console.log(`[ph] active PH row already exists for username="${phUsername}" id=${exists[0].id} — skipping saveAccount (would dup)`);
      return phUsername;
    }
  }

  const result = await s.saveAccount('producthunt', {
    username: phUsername,
    email: twEmail ?? `${twUsername}@wisentmedia.com`,
    password: twPassword ?? 'linked_to_twitter',
  });
  console.log(`[ph] ${result}`);
  await stampLinkedTwitter(phUsername, twUsername).catch((e) => console.log(`[ph] stamp err: ${e.message?.slice(0, 80)}`));
  await autoBindCharacter(phUsername, 'producthunt').then(r => console.log(`[bind] ${JSON.stringify(r)}`)).catch((e) => console.log(`[bind] err: ${e.message?.slice(0, 80)}`));
  return phUsername;
}

// Single attempt — the prior MAX_RETRIES=5 loop ran the same deterministic
// signup with the same Twitter SSO account, same proxy, and same captcha
// solver on every iteration; if attempt 1 fails (twitter cookies expired,
// captcha unsolvable, account purged) attempts 2-5 fail identically and
// just generate 5x the bot-signal volume against PH's signup endpoint.
// On failure, the worker queues a fresh row on next routine tick.
const s = await WSession.start({ label: 'producthunt_register', proxy });
try {
  const username = await signup(s);
  console.log(`PASS: ${username}`);
  await s.close();
  process.exit(0);
} catch (e) {
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  await s.close().catch(() => {});
  process.exit(1);
}
