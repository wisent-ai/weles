import { WSession } from '../../dist/session/wsession.js';

const URL = 'https://www.instagram.com/accounts/emailsignup/';
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
  const id = await s.generateIdentity('instagram');
  const name = `${id.firstName} ${id.lastName}`;
  console.log(`[ig] identity: ${id.username} / ${id.email}`);

  // Navigate
  await s.goto(URL);
  await sleep(4);

  // Dismiss cookie consent via JS click (avoids mouse.move crash)
  const text = await readPage(s);
  if (text.includes('cookies') || text.includes('cookie')) {
    await s.page.evaluate(`(() => { var bs = document.querySelectorAll('button'); for (var b of bs) { if (b.textContent.includes('Allow all') || b.textContent.includes('Allow essential')) { b.click(); return; } } })()`).catch(() => {});
    await sleep(2);
  }

  // Fill signup form
  await s.fill('emailOrPhone', id.email);
  await sleep(1);
  await s.fill('fullName', name);
  await sleep(1);
  await s.fill('username', id.username);
  await sleep(1);
  await s.fill('password', id.password);
  await sleep(1);

  // Click Sign up
  await s.page.evaluate(`(() => { var b = document.querySelector('button[type="submit"]'); if (b) b.click(); })()`).catch(() => {});
  await sleep(5);

  // Birthday page
  const t2 = await readPage(s);
  if (t2.includes('birthday') || t2.includes('birth') || t2.includes('date of birth')) {
    console.log('[ig] birthday page detected');
    await s.select('Month', id.birthMonth).catch(() => {});
    await s.select('Day', id.birthDay).catch(() => {});
    await s.select('Year', id.birthYear).catch(() => {});
    await sleep(1);
    await s.click('Next').catch(() => {});
    await s.page.evaluate(`(() => { var b = document.querySelector('button[type="submit"], button.aOOlW'); if (b) b.click(); })()`).catch(() => {});
    await sleep(5);
  }

  // Email verification code
  const t3 = await readPage(s);
  console.log(`[ig] after signup: ${t3.slice(0, 80).replace(/\n/g, ' ')}`);
  if (t3.includes('confirmation') || t3.includes('code') || t3.includes('verify') || t3.includes('enter the')) {
    console.log('[ig] email verification...');
    const code = await s.checkEmail(id.email, 'instagram');
    console.log(`[ig] email code: ${code}`);
    // Try regular input first, then individual digit inputs
    // Fill code — find the only enabled text input on the page and use keyboard
    await s.page.evaluate(`(() => { var inputs = document.querySelectorAll('input[type="text"]:not([disabled]), input:not([type]):not([disabled])'); for (var inp of inputs) { if (inp.offsetParent !== null) { inp.focus(); inp.click(); return; } } })()`).catch(() => {});
    await sleep(1);
    await s.page.keyboard.type(code, { delay: 50 }).catch(() => {});
    await sleep(2);
    await s.page.evaluate(`(() => { var b = document.querySelector('button[type="button"]:not([disabled])'); var bs = document.querySelectorAll('button'); for (var btn of bs) { if (!btn.disabled && btn.textContent.trim() && btn.offsetParent) { btn.click(); return; } } })()`).catch(() => {});
    await sleep(5);
  }

  // Handle "confirm you're human" captcha or skip onboarding
  for (let i = 0; i < 15; i++) {
    if (s.page.isClosed?.()) { console.log('[ig] page closed'); throw new Error('page_closed'); }
    const url = s.page.url?.() ?? '';
    const t = await readPage(s);
    console.log(`[ig] onboarding ${i}: url=${url.slice(-30)} text=${t.slice(0, 60).replace(/\n/g, ' ')}`);
    if (url.includes('/explore') || url.includes('/direct') || url.includes('/accounts/onetap') || t.includes('suggested for you')) break;
    // Image text captcha — screenshot the image, send to solver
    if (t.includes('confirm that you') || t.includes('enter the code from the image') || url.includes('/suspended')) {
      console.log('[ig] captcha page detected');
      await s.click('Continue').catch(() => {});
      await sleep(3);
      const t2 = await readPage(s);
      if (t2.includes('enter the code from the image') || t2.includes('hear this code')) {
        console.log('[ig] solving image captcha...');
        // Screenshot the captcha image element directly (cross-origin safe)
        const imgEl = await s.page.$('img[src*="captcha"], img[src*="tfbimage"]').catch(() => null) ?? await s.page.$('img[width]').catch(() => null);
        const imgB64 = imgEl ? (await imgEl.screenshot({ type: 'png' }).catch(() => null))?.toString('base64') : null;
        if (imgB64 && imgB64.length > 100) {
          console.log(`[ig] captcha image captured (${imgB64.length} chars base64)`);
          const key = process.env.TWOCAPTCHA_API_KEY;
          if (key) {
            const cr = await (await fetch('https://2captcha.com/in.php', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: `key=${key}&method=base64&body=${encodeURIComponent(imgB64)}&numeric=1&min_len=4&max_len=8&json=1` })).json().catch(() => ({}));
            if (cr.status === 1) {
              console.log(`[ig] 2captcha task: ${cr.request}`);
              for (let p = 0; p < 30; p++) {
                await sleep(5);
                const res = await (await fetch(`https://2captcha.com/res.php?key=${key}&action=get&id=${cr.request}&json=1`)).json().catch(() => ({}));
                if (res.status === 1) { console.log(`[ig] captcha solved: ${res.request}`); await s.fill('Enter the code from the image', res.request); await sleep(1); await s.click('Next').catch(() => {}); await s.press('Enter').catch(() => {}); await sleep(5); break; }
                if (res.request !== 'CAPCHA_NOT_READY') { console.log(`[ig] captcha error: ${res.request}`); break; }
              }
            } else { console.log(`[ig] 2captcha submit error: ${JSON.stringify(cr)}`); }
          }
        } else { console.log('[ig] no captcha image found'); }
      }
      continue;
    }
    await s.click('Skip').catch(() => {});
    await s.click('Not now').catch(() => {});
    await s.click('Next').catch(() => {});
    await sleep(2);
  }

  // Verify success: check for auth cookies
  if (s.page.isClosed?.()) throw new Error('page_closed');
  const cookies = await s.ctx.cookies().catch(() => []);
  const authCookies = cookies.filter(c => c.domain?.includes('instagram.com') && (c.name === 'sessionid' || c.name === 'csrftoken'));
  if (authCookies.length < 2) {
    console.log(`[ig] no auth cookies (cookies=${authCookies.map(c => c.name)})`);
    throw new Error('no_auth_cookies');
  }
  console.log(`[ig] auth cookies verified: ${authCookies.map(c => c.name).join(', ')}`);

  // Save account
  const result = await s.saveAccount('instagram', {
    username: id.username, email: id.email, password: id.password, name,
  });
  console.log(`[ig] ${result}`);
  return id.username;
}

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  console.log(`\n=== Instagram signup attempt ${attempt}/${MAX_RETRIES} ===`);
  const s = await WSession.start({ label: `instagram_register_${attempt}`, proxy });
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
