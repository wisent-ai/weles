import { WSession } from '../../dist/session/wsession.js';

const URL = 'https://x.com/i/flow/signup';
const MAX_RETRIES = 5;
const proxy = process.env.PROXY_URL || 'residential';
const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

const SKIP_BUTTONS = ['Skip for now', 'Skip', 'Not now', 'Next'];

// Read page text AND check for Arkose iframe (which is cross-origin, invisible to innerText)
async function readPage(s) {
  return (await s.page.evaluate(`(() => {
    var t = (document.body?.innerText ?? '').substring(0, 2000);
    var modal = document.querySelector('[role="dialog"]');
    if (modal) t = modal.innerText.substring(0, 1000) + '\\n' + t;
    if (document.querySelector('iframe#arkoseFrame, iframe[src*="arkoselabs"]')) t = 'ARKOSE_IFRAME_PRESENT\\n' + t;
    return t;
  })()`).catch(() => '')).toLowerCase();
}

async function signup(s) {
  const id = await s.generateIdentity('twitter');
  const name = `${id.firstName} ${id.lastName}`;
  console.log(`[tw] identity: ${id.username} / ${id.email}`);

  // Navigate
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

  // Click through wizard: Next → Customise → Sign up → Authenticate
  for (let i = 0; i < 8; i++) {
    await sleep(3);
    const t = await readPage(s);
    const preview = t.slice(0, 100).replace(/\n/g, ' ');
    console.log(`[tw] wizard step ${i}: ${preview}`);

    // Arkose captcha detected via iframe
    if (t.includes('arkose_iframe_present')) {
      console.log('[tw] Arkose iframe detected, solving FunCaptcha...');
      const solved = await s.solveCaptcha();
      console.log(`[tw] captcha result: ${solved}`);
      await sleep(5);
      break;
    }

    // Past captcha — verification or password
    if (t.includes('verification') || t.includes('code') || t.includes('password')) break;

    // Homepage means flow was lost
    if (t.includes('happening now') || t.includes('join today')) {
      if (i > 2) { console.log('[tw] flow lost to homepage'); throw new Error('flow_lost'); }
    }

    // Click Sign up or Next
    const clicked = await s.click('Sign up');
    if (clicked === 'no-target-found') await s.click('Next');
    await sleep(2);
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
    await sleep(3);
  }

  // Password
  const text4 = await readPage(s);
  if (text4.includes('password') || text4.includes('at least')) {
    await s.fill('Password', id.password);
    await sleep(1);
    await s.click('Next');
    await sleep(3);
  }

  // Skip onboarding
  for (let i = 0; i < 5; i++) {
    const t = await readPage(s);
    if (t.includes('home') || t.includes('what\'s happening')) break;
    for (const btn of SKIP_BUTTONS) {
      const r = await s.click(btn);
      if (r !== 'no-target-found') { await sleep(2); break; }
    }
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
