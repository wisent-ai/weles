import { WSession } from '../../dist/session/wsession.js';
import { chromium } from 'playwright';

const URL = 'https://x.com/i/flow/signup?lang=en';
const MAX_RETRIES = 5;
const USE_BRIGHTDATA = !!process.env.BRIGHTDATA_BROWSER_WS;
const proxy = USE_BRIGHTDATA ? 'none' : (process.env.PROXY_URL || 'none');
const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

const SKIP_BUTTONS = ['Skip for now', 'Not now', 'Next', 'Skip'];

// Read page text, check for Arkose iframe, and extract its data if present
async function readPage(s) {
  const result = await s.page.evaluate(`(() => {
    var t = (document.body?.innerText ?? '').substring(0, 2000);
    var modal = document.querySelector('[role="dialog"]');
    if (modal) t = modal.innerText.substring(0, 1000) + '\\n' + t;
    var ark = document.querySelector('iframe#arkoseFrame, iframe[src*="arkoselabs"]');
    var arkData = null;
    if (ark) {
      t = 'ARKOSE_IFRAME_PRESENT\\n' + t;
      var src = ark.getAttribute('src') || '';
      var pk = (src.match(/\\/([A-F0-9-]{36})\\//)||[])[1] || '';
      var bl = (src.match(/[?&]data=([^&]+)/)||[])[1] || '';
      arkData = { publicKey: pk, blob: decodeURIComponent(bl), subdomain: (new URL(src)).origin };
    }
    return { text: t, arkose: arkData };
  })()`).catch(() => ({ text: '', arkose: null }));
  s._lastArkose = result.arkose;
  return result.text.toLowerCase();
}

async function signup(s) {
  const id = await s.generateIdentity('twitter');
  const name = `${id.firstName} ${id.lastName}`;
  console.log(`[tw] identity: ${id.username} / ${id.email}`);

  // Set language to English before navigating
  await s.ctx.addCookies([{ name: 'lang', value: 'en', domain: '.x.com', path: '/' }]).catch(() => {});
  await s.goto(URL);
  await sleep(5);

  // Dismiss cookie consent if present
  const text = await readPage(s);
  if (text.includes('cookies') && text.includes('partners')) {
    await s.click('Refuse non-essential cookies').catch(() => {});
    await sleep(2);
  }

  // Handle "Something went wrong" error
  if (text.includes('something went wrong') || text.includes('try reloading')) {
    console.log('[tw] got error page, retrying...');
    throw new Error('page_error');
  }

  // Click Create account
  await s.click('Create account');
  await sleep(3);

  // Fill name
  await s.fill('Name', name);
  await sleep(1);

  // Switch to email
  await s.click('Use email instead').catch(() => {});
  await sleep(1);

  // Fill email (or phone if email not available)
  const pageText = await readPage(s);
  if (pageText.includes('email')) {
    await s.fill('Email', id.email);
  } else {
    const phone = await s.checkSms('twitter', 'UK');
    console.log(`[tw] SMS: ${phone}`);
    await s.fill('Phone', s.resolveEnv('$TWITTER_NEW_PHONE'));
  }
  await sleep(1);

  // DOB
  await s.select('Month', id.birthMonth);
  await s.select('Day', id.birthDay);
  await s.select('Year', id.birthYear);
  await sleep(1);

  // Click Next on form and wait for page to change. Use s.clickSelector so
  // the event is isTrusted=true (the comment at password-submit below already
  // flagged the evaluate-click pattern — same fix for this Next button).
  await s.clickSelector('[data-testid="ocfSignupNextLink"]').catch(() => {});
  console.log('[tw] clicked Next, waiting for page change...');

  // Poll until we leave the form page or hit a known state
  for (let w = 0; w < 30; w++) {
    await sleep(2);
    const t = await readPage(s);
    const preview = t.slice(0, 80).replace(/\n/g, ' ');
    if (w % 5 === 0) console.log(`[tw] waiting ${w}: ${preview}`);

    // Arkose captcha — wait for Bright Data auto-solve, then try our solver
    if (t.includes('arkose_iframe_present')) {
      console.log(`[tw] Arkose iframe present (wait ${w}), checking if auto-solved...`);
      continue;  // Just wait and re-check — Bright Data may solve it automatically
    }
    if (t.includes('sent you a code') || t.includes('verification')) break;
    if (t.includes('customise') || t.includes('customize')) {
      await s.clickSelector('[data-testid="ocfSignupNextLink"]').catch(() => {});
      continue;
    }
    if (t.includes('authenticate')) {
      await s.click('Authenticate');
      continue;
    }
    if (t.includes('happening now') && t.includes('join today') && w > 5) { throw new Error('flow_lost'); }
    if (t.includes('password')) break;
  }

  // Email or phone verification
  const text3 = await readPage(s);
  if (text3.includes('verification') || text3.includes('sent') || text3.includes('code')) {
    if (text3.includes('phone') || text3.includes('text message')) {
      console.log('[tw] phone verification...');
      const code = await s.pollSmsCode();
      console.log(`[tw] SMS code: ${code}`);
      await s.fill('code', code);
    } else {
      console.log('[tw] email verification...');
      const code = await s.checkEmail(id.email, 'x.com');
      console.log(`[tw] email code: ${code}`);
      await s.fill('code', code);
    }
    await sleep(1);
    await s.click('Next');
    await sleep(5);

    // Check for "unable to confirm you're human" error
    const afterCode = await readPage(s);
    console.log(`[tw] after code submit: ${afterCode.slice(0, 80).replace(/\n/g, ' ')}`);
    if (afterCode.includes('unable to confirm') || afterCode.includes('not a robot')) {
      console.log('[tw] captcha failed server-side, retrying...');
      throw new Error('captcha_server_reject');
    }
  }

  // Password — wait for page to render after verification
  await sleep(3);
  const text4 = await readPage(s);
  console.log(`[tw] password check: ${text4.slice(0, 80).replace(/\n/g, ' ')}`);
  if (text4.includes('password') || text4.includes('at least')) {
    await s.fill('Password', id.password);
    await sleep(1);
    // Route through Playwright locator.click → CDP dispatchMouseEvent → Blink
    // SetTrusted(true). Previous page.evaluate(b.click()) produced isTrusted=false
    // which Arkose-gated submits reject (same pattern as TikTok select.ts fix
    // in commit ce369f6). Fall through to Enter key if neither selector matches.
    await s.page.locator('[data-testid="SignupButton"], [data-testid="LoginForm_Login_Button"]').first().click().catch(() => {});
    await s.press('Enter').catch(() => {});
    await sleep(5);
  }

  // Skip onboarding until home feed
  for (let i = 0; i < 15; i++) {
    const url = s.page.url?.() ?? '';
    const t = await readPage(s);
    console.log(`[tw] onboarding ${i}: url=${url.slice(-30)} text=${t.slice(0, 60).replace(/\n/g, ' ')}`);
    if (url.includes('/home') || t.includes('what\'s happening') || t.includes('post something') || t.includes('for you')) break;
    // Detect logged-out homepage (dead end)
    if (url === 'https://x.com/' && t.includes('happening now') && t.includes('join today')) { await s.goto('https://x.com/home'); await sleep(3); break; }
    for (const btn of SKIP_BUTTONS) {
      const r = await s.click(btn);
      if (r !== 'no-target-found') { await sleep(2); break; }
    }
  }
  // Navigate to home if still stuck in flow
  if (!(s.page.url?.() ?? '').includes('/home')) {
    await s.goto('https://x.com/home');
    await sleep(3);
  }

  // Verify success: check for auth cookies
  const cookies = await s.ctx.cookies().catch(() => []);
  const authCookies = cookies.filter(c => (c.domain?.includes('.x.com') || c.domain?.includes('.twitter.com')) && (c.name === 'auth_token' || c.name === 'ct0'));
  if (authCookies.length < 2) {
    const url = s.page.url?.() ?? '';
    console.log(`[tw] no auth cookies found (url=${url}, cookies=${authCookies.map(c => c.name)})`);
    throw new Error('no_auth_cookies');
  }
  console.log(`[tw] auth cookies verified: ${authCookies.map(c => c.name).join(', ')}`);

  // Save account
  const result = await s.saveAccount('twitter', {
    username: id.username, email: id.email, password: id.password, name,
  });
  console.log(`[tw] ${result}`);
  return id.username;
}

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  console.log(`\n=== Twitter signup attempt ${attempt}/${MAX_RETRIES} ===`);
  const s = await WSession.start({ label: `twitter_register_${attempt}`, proxy });
  try {
    const username = await signup(s);
    console.log(`PASS: ${username}`);
    await s.close();
    process.exit(0);
  } catch (e) {
    console.log(`FAIL (attempt ${attempt}): ${e.message?.slice(0, 200)}`);
    await s.close().catch(() => {});
    if (attempt === MAX_RETRIES) { console.log('All attempts exhausted'); process.exit(1); }
    console.log('Retrying with fresh proxy IP in 3s...');
    await sleep(3);
  }
}
