import { WSession } from '../../../dist/session/wsession.js';
import { injectProviderCookies } from '../../../dist/platforms/_shared/cross_platform_oauth.js';
import { listAccounts } from '../_shared/skarbiec/accounts.mjs';
import { pageSettled } from '../_shared/page/settled.mjs';
import { clickFirst, control, field } from '../_shared/page/offers.mjs';

// An active Instagram account whose record carries a session (its cookies).
function findUsableInstagramAccount() {
  return listAccounts('instagram')
    .find((account) => Array.isArray(account.metadata?.cookies) && account.metadata.cookies.length >= 2) ?? null;
}

const URL = 'https://www.threads.net/login';
const proxy = process.env.PROXY_URL || 'none';

function pathOf(page) {
  return new globalThis.URL(page.url()).pathname;
}

function onInstagram(page) {
  return new globalThis.URL(page.url()).hostname.endsWith('instagram.com');
}

function onThreadsFeed(page) {
  const url = new globalThis.URL(page.url());
  return /(^|\.)threads\.(net|com)$/.test(url.hostname) && !url.pathname.startsWith('/login')
    && (url.pathname === '/' || url.pathname.startsWith('/@'));
}

// The Instagram account cannot go on: its session landed on a block or a
// challenge, or Instagram asks for a phone.
async function instagramBlocked(page) {
  if (!onInstagram(page)) return false;
  const path = pathOf(page);
  return path.startsWith('/accounts/suspended') || path.startsWith('/challenge') || (await field(page, 'phone_number')) !== null;
}

async function signup(s) {
  const page = s.page;
  const igAccount = findUsableInstagramAccount();
  if (!igAccount) throw new Error('no_instagram_account_with_cookies');
  const igCookies = igAccount.metadata.cookies;
  const igUsername = igAccount.username;
  const igPassword = igAccount.metadata?.password;
  const igEmail = igAccount.metadata?.email;
  console.log(`[threads] using instagram account: ${igUsername} (${igCookies.length} cookies)`);

  const injected = await injectProviderCookies(s.ctx, 'instagram', igCookies, { extraMirrorDomains: ['.threads.net'] });
  console.log(`[threads] injected ${injected} instagram+threads cookies`);

  await s.goto(URL);
  await pageSettled(page);

  // Cookie consent: one click on whichever consent control the page offers.
  if (await clickFirst(page, 'button', ['Allow all cookies', 'Allow essential and optional cookies'])) {
    await pageSettled(page);
    if (page.isClosed()) throw new Error('page_crashed_on_cookie_dismiss');
  }

  // Sign in through the Instagram session.
  if (await clickFirst(page, 'button', ['Continue with Instagram', 'Log in with Instagram', 'Use Instagram'])
    || await clickFirst(page, 'link', ['Continue with Instagram', 'Log in with Instagram', 'Use Instagram'])) {
    await pageSettled(page);
  }

  // Instagram's own login form means the cookies no longer carry a session.
  if (onInstagram(page) && (await field(page, 'password'))) {
    console.log('[threads] re-authenticating with instagram credentials');
    if (!igPassword) throw new Error('instagram_cookies_expired_no_password');
    await s.fill('username', igUsername);
    await pageSettled(page);
    await s.fill('password', igPassword);
    await pageSettled(page);
    const submit = page.locator('button[type="submit"]').first();
    if (!(await submit.isVisible())) throw new Error('instagram login form offers no submit');
    await submit.click();
    await pageSettled(page);
  }

  // Instagram's own prompts after login (save login, notifications) each
  // offer "Not now".
  for (let i = 0; i < 3; i++) {
    if (!(await clickFirst(page, 'button', ['Not now']))) break;
    await pageSettled(page);
  }

  // Threads onboarding: each step offers a control to take it forward.
  for (let i = 0; i < 15; i++) {
    if (page.isClosed()) throw new Error('page_crashed_during_onboarding');
    console.log(`[threads] onboarding ${i}: url=${page.url().slice(-40)}`);
    if (await instagramBlocked(page)) throw new Error(`instagram_account_suspended_or_challenged: ${igUsername}`);
    if (onThreadsFeed(page)) {
      console.log('[threads] reached main feed');
      break;
    }
    if (await clickFirst(page, 'button', ['Import from Instagram', 'Use Instagram'])) { await pageSettled(page); continue; }
    if (await control(page, 'radio', 'Public profile')) {
      await (await control(page, 'radio', 'Public profile')).click();
      await clickFirst(page, 'button', ['Continue', 'Next']);
      await pageSettled(page);
      continue;
    }
    if (await clickFirst(page, 'button', ['Follow all'])) {
      await clickFirst(page, 'button', ['Continue', 'Next', 'Skip']);
      await pageSettled(page);
      continue;
    }
    if (await clickFirst(page, 'button', ['Join Threads', 'Sign up', 'Get started'])) { await pageSettled(page); continue; }
    if (await clickFirst(page, 'button', ['Not now', 'Skip', 'Continue', 'Next', 'Done'])) { await pageSettled(page); continue; }
    throw new Error(`threads onboarding offers no control to continue at ${page.url()}`);
  }

  // Success is the Threads session cookie, not what the page says.
  const cookies = await s.ctx.cookies();
  const threadsAuth = cookies.filter(c =>
    (c.domain?.includes('threads.net') || c.domain?.includes('threads.com')) &&
    (c.name === 'sessionid' || c.name === 'ig_did' || c.name === 'csrftoken')
  );
  if (threadsAuth.length < 1) {
    console.log(`[threads] no threads auth cookies. all cookies: ${cookies.map(c => `${c.name}@${c.domain}`).slice(0, 20).join(', ')}`);
    throw new Error('no_threads_auth_cookies');
  }
  console.log(`[threads] auth cookies: ${threadsAuth.map(c => `${c.name}@${c.domain}`).join(', ')}`);

  const result = await s.saveAccount('threads', {
    username: igUsername,
    email: igEmail ?? `${igUsername}@wisentmedia.com`,
    password: igPassword ?? 'linked_to_instagram',
  });
  console.log(`[threads] ${result}`);
  return igUsername;
}

const s = await WSession.start({ label: 'threads_register', proxy });
try {
  const username = await signup(s);
  console.log(`PASS: ${username}`);
} catch (e) {
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  await s.close();
}
