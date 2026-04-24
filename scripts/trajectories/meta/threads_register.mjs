import { WSession } from '../../../dist/session/wsession.js';
import { injectProviderCookies } from '../../../dist/platforms/_shared/cross_platform_oauth.js';

async function findUsableInstagramAccount() {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!supabaseUrl || !supabaseKey) return null;
  const res = await fetch(
    `${supabaseUrl}/rest/v1/social_accounts?platform=eq.instagram&is_active=eq.true&select=id,platform,username,metadata&order=created_at.desc&limit=20`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } },
  );
  if (!res.ok) return null;
  const rows = await res.json();
  // Prefer accounts that (a) have cookies, (b) aren't marked suspended
  for (const a of rows) {
    const hasCookies = Array.isArray(a.metadata?.cookies) && a.metadata.cookies.length >= 2;
    const suspended = String(a.metadata?.status ?? '').toLowerCase().includes('suspend');
    if (hasCookies && !suspended) return a;
  }
  // Otherwise any with cookies
  for (const a of rows) {
    if (Array.isArray(a.metadata?.cookies) && a.metadata.cookies.length >= 2) return a;
  }
  return rows[0] ?? null;
}

const URL = 'https://www.threads.net/login';
const MAX_RETRIES = 5;
const USE_BRIGHTDATA = !!process.env.BRIGHTDATA_BROWSER_WS;
const proxy = USE_BRIGHTDATA ? 'none' : (process.env.PROXY_URL || 'none');
const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

async function readPage(s) {
  return (await s.page.evaluate(`(() => {
    var t = (document.body?.innerText ?? '').substring(0, 2000);
    return t;
  })()`).catch(() => '')).toLowerCase();
}


async function signup(s) {
  // 1. Fetch existing Instagram account with cookies from DB (skip suspended ones if possible)
  const igAccount = await findUsableInstagramAccount();
  if (!igAccount) throw new Error('no_instagram_account_in_db');
  const igCookies = igAccount.metadata?.cookies ?? [];
  const igUsername = igAccount.username;
  const igPassword = igAccount.metadata?.password;
  const igEmail = igAccount.metadata?.email;
  const igStatus = igAccount.metadata?.status ?? 'unknown';
  console.log(`[threads] using instagram account: ${igUsername} status=${igStatus} (${igCookies.length} cookies)`);

  if (igCookies.length < 2) throw new Error('instagram_account_missing_cookies');

  // 2. Inject cookies BEFORE navigation
  const injected = await injectProviderCookies(s.ctx, 'instagram', igCookies, { extraMirrorDomains: ['.threads.net'] });
  console.log(`[threads] injected ${injected} instagram+threads cookies`);

  // 3. Navigate to Threads (redirects to threads.com)
  await s.goto(URL);
  await sleep(4);

  // Dismiss cookie consent — stop after first successful click to avoid crash-on-double-click
  const text0 = await readPage(s);
  if (text0.includes('cookies') || text0.includes('cookie')) {
    const r1 = await s.click('Allow all cookies').catch(() => 'no-target-found');
    if (r1 === 'no-target-found') await s.click('Allow essential and optional cookies').catch(() => {});
    await sleep(2);
    if (s.page.isClosed?.()) throw new Error('page_crashed_on_cookie_dismiss');
  }

  // 4. Click "Continue with Instagram" / "Log in with Instagram"
  const t1 = await readPage(s);
  console.log(`[threads] login page: ${t1.slice(0, 100).replace(/\n/g, ' ')}`);
  if (t1.includes('log in with instagram') || t1.includes('continue with instagram') || t1.includes('use instagram')) {
    await s.click('Continue with Instagram').catch(() => {});
    await s.click('Log in with Instagram').catch(() => {});
    await s.click('Use Instagram').catch(() => {});
    await sleep(5);
  }

  // 5. If redirected to Instagram login page (cookies expired), re-authenticate
  const url1 = s.page.url?.() ?? '';
  const t2 = await readPage(s);
  if (url1.includes('instagram.com') && (t2.includes('phone number, username') || t2.includes('password'))) {
    console.log('[threads] re-authenticating with instagram credentials');
    if (!igPassword) throw new Error('instagram_cookies_expired_no_password');
    await s.fill('username', igUsername);
    await sleep(1);
    await s.fill('password', igPassword);
    await sleep(1);
    await s.clickSelector('button[type="submit"]').catch(() => {});
    await sleep(6);
  }

  // 6. Dismiss "Save login info" / "Turn on notifications" prompts
  for (let i = 0; i < 3; i++) {
    const t = await readPage(s);
    if (t.includes('save login') || t.includes('save info') || t.includes('not now')) {
      await s.click('Not now').catch(() => {});
      await sleep(2);
    } else break;
  }

  // 7. Threads onboarding — profile setup -> follow suggestions -> done
  for (let i = 0; i < 15; i++) {
    if (s.page.isClosed?.()) throw new Error('page_crashed_during_onboarding');
    const url = s.page.url?.() ?? '';
    const t = await readPage(s);
    console.log(`[threads] onboarding ${i}: url=${url.slice(-40)} text=${t.slice(0, 80).replace(/\n/g, ' ')}`);

    // Instagram account blocked / suspended / needs phone verification — can't continue to Threads
    if (url.includes('/accounts/suspended') || url.includes('/challenge') || t.includes('enter your mobile number')) {
      throw new Error(`instagram_account_suspended_or_challenged: ${igUsername}`);
    }

    // Success: reached main feed (no /login in URL and threads domain)
    if (!url.includes('/login') && (url.match(/threads\.(net|com)\/?(\?|$)/) || url.includes('/@') || (t.includes('for you') && t.includes('following')))) {
      console.log('[threads] reached main feed');
      break;
    }

    if (t.includes('import from instagram') || t.includes('use instagram')) {
      await s.click('Import from Instagram').catch(() => {});
      await s.click('Use Instagram').catch(() => {});
      await sleep(3);
      continue;
    }
    if (t.includes('public profile') || t.includes('private profile') || t.includes('visibility')) {
      await s.click('Public profile').catch(() => {});
      await s.click('Continue').catch(() => {});
      await s.click('Next').catch(() => {});
      await sleep(3);
      continue;
    }
    if (t.includes('follow the same') || t.includes('follow all') || t.includes('suggested')) {
      await s.click('Follow all').catch(() => {});
      await s.click('Continue').catch(() => {});
      await s.click('Next').catch(() => {});
      await s.click('Skip').catch(() => {});
      await sleep(3);
      continue;
    }
    if (t.includes('join threads') || t.includes('sign up') || t.includes('get started')) {
      await s.click('Join Threads').catch(() => {});
      await s.click('Sign up').catch(() => {});
      await s.click('Get started').catch(() => {});
      await sleep(4);
      continue;
    }
    if (t.includes('notifications')) {
      await s.click('Not now').catch(() => {});
      await s.click('Skip').catch(() => {});
      await sleep(2);
      continue;
    }
    // Generic forward-click attempt when no specific pattern matched
    await s.click('Continue').catch(() => {});
    await s.click('Next').catch(() => {});
    await s.click('Done').catch(() => {});
    await sleep(3);
  }

  // 8. Verify success — Threads auth cookies on threads.net domain
  const cookies = await s.ctx.cookies().catch(() => []);
  const threadsAuth = cookies.filter(c =>
    (c.domain?.includes('threads.net') || c.domain?.includes('threads.com')) &&
    (c.name === 'sessionid' || c.name === 'ig_did' || c.name === 'csrftoken')
  );
  if (threadsAuth.length < 1) {
    console.log(`[threads] no threads auth cookies. all cookies: ${cookies.map(c => `${c.name}@${c.domain}`).slice(0, 20).join(', ')}`);
    throw new Error('no_threads_auth_cookies');
  }
  console.log(`[threads] auth cookies: ${threadsAuth.map(c => `${c.name}@${c.domain}`).join(', ')}`);

  // 9. Save Threads account (linked to the same Instagram username)
  const result = await s.saveAccount('threads', {
    username: igUsername,
    email: igEmail ?? `${igUsername}@wisentmedia.com`,
    password: igPassword ?? 'linked_to_instagram',
  });
  console.log(`[threads] ${result}`);
  return igUsername;
}

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  console.log(`\n=== Threads signup attempt ${attempt}/${MAX_RETRIES} ===`);
  const s = await WSession.start({ label: `threads_register_${attempt}`, proxy });
  try {
    const username = await signup(s);
    console.log(`PASS: ${username}`);
    await s.close();
    process.exit(0);
  } catch (e) {
    console.log(`FAIL (attempt ${attempt}): ${e.message?.slice(0, 200)}`);
    await s.close().catch(() => {});
    if (attempt === MAX_RETRIES) { console.log('All attempts exhausted'); process.exit(1); }
    console.log('Retrying in 3s...');
    await sleep(3);
  }
}
