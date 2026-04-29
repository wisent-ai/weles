import { WSession } from '../../dist/session/wsession.js';
import { humanType, humanFill } from '../../dist/human/keyboard.js';

const URL = 'https://www.instagram.com/accounts/emailsignup/';
const MAX_RETRIES = 5;
const USE_BRIGHTDATA = !!process.env.BRIGHTDATA_BROWSER_WS;
// Build US Oxylabs proxy URL directly — DB metadata routes to Brazil for Discord, but Instagram needs US
const oxyUser = process.env.OXYLABS_USERNAME;
const oxyPass = process.env.OXYLABS_PASSWORD;
const proxy = USE_BRIGHTDATA ? 'none' : (process.env.PROXY_URL || (oxyUser && oxyPass ? `http://customer-${oxyUser}-cc-us-sessid-${Math.floor(Math.random()*9999999)}:${oxyPass}@pr.oxylabs.io:7777` : 'none'));
const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

async function readPage(s) {
  return (await s.page.evaluate(`(() => {
    var t = (document.body?.innerText ?? '').substring(0, 2000);
    return t;
  })()`).catch(() => '')).toLowerCase();
}

async function signup(s) {
  const id = await s.generateIdentity('instagram');
  id.email = `${id.username}@wisentmedia.com`;
  s._env['INSTAGRAM_NEW_EMAIL'] = id.email;
  const name = `${id.firstName} ${id.lastName}`;

  // Get a phone number for signup (skip email — wisentmedia.com codes are rejected)
  let phone = await s.checkSms('instagram', 'US');
  if (phone.startsWith('error')) phone = await s.checkSms('instagram', 'UK');
  console.log(`[ig] identity: ${id.username} / phone=${phone}`);
  if (phone.startsWith('error')) throw new Error('no_phone_number');
  const phoneNum = s.resolveEnv('$INSTAGRAM_NEW_PHONE');
  const digits = phoneNum.replace(/^\+\d{1,2}/, '').replace(/\D/g, '');

  // Navigate
  await s.goto(URL);
  await sleep(4);

  // Dismiss cookie consent via s.jsClick (avoids mouse.move crash on
  // Instagram's heavy page; the js-prefix atom marks intentional untrusted).
  const text = await readPage(s);
  if (text.includes('cookies') || text.includes('cookie')) {
    await s.jsClick('button', 'Allow essential').catch(() => {});
    await sleep(2);
  }

  // Fill signup form with phone number
  await s.fill('emailOrPhone', digits);
  await sleep(1);
  await s.fill('fullName', name);
  await sleep(1);
  await s.fill('username', id.username);
  await sleep(1);
  await s.fill('password', id.password);
  await sleep(1);

  // Take screenshot before submit to verify form state
  await s.page.screenshot({ path: `/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/weles/recordings/ig_before_submit.png` }).catch(() => {});
  // Click Sign up — use s.clickSelector so the submit dispatches with
  // isTrusted=true. Instagram's /api/v1/* rate_limited detector keys off
  // feedback_required JSON that fires when the Sign-up click fails the
  // isTrusted check; see docs/DETECTION_ANTIPATTERNS.md §1.
  await s.clickSelector('button[type="submit"]').catch(() => {});
  await sleep(5);
  // Screenshot after submit
  await s.page.screenshot({ path: `/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/weles/recordings/ig_after_submit.png` }).catch(() => {});

  // Birthday page
  const t2 = await readPage(s);
  if (t2.includes('birthday') || t2.includes('birth') || t2.includes('date of birth')) {
    console.log('[ig] birthday page detected');
    await s.select('Month', id.birthMonth).catch(() => {});
    await s.select('Day', id.birthDay).catch(() => {});
    await s.select('Year', id.birthYear).catch(() => {});
    await sleep(1);
    await s.click('Next').catch(() => {});
    // Submit the birthday form via a trusted click (see §1 in the anti-
    // patterns doc). button.aOOlW is Instagram's submit class when
    // type=submit isn't present on the birthday variant of the form.
    await s.clickSelector('button[type="submit"], button.aOOlW').catch(() => {});
    await sleep(5);
  }

  // Wait for confirmation code page to appear (or any post-signup page)
  let t3 = '';
  for (let w = 0; w < 30; w++) {
    if (s.page.isClosed?.()) { console.log('[ig] page closed during wait'); throw new Error('page_closed'); }
    await sleep(3);
    t3 = await readPage(s);
    const url = s.page.url?.() ?? '';
    // Any of these indicate we've moved past the signup form
    if (t3.includes('confirmation') || t3.includes('code') || t3.includes('verify') || t3.includes('enter the') || t3.includes('phone') || t3.includes('mobile') || t3.includes('suspended') || t3.includes('confirm that you')) break;
    if (url.includes('/password/reset')) { console.log('[ig] redirected to password reset'); throw new Error('password_reset'); }
    if (w % 5 === 0) console.log(`[ig] waiting for code page ${w}: url=${url.slice(-30)} text=${t3.slice(0, 60).replace(/\n/g, ' ')}`);
  }
  console.log(`[ig] after signup: ${t3.slice(0, 120).replace(/\n/g, ' ')}`);
  let smsCode = '';
  if (t3.includes('confirmation') || t3.includes('code') || t3.includes('verify') || t3.includes('enter the')) {
    console.log('[ig] SMS verification — polling for code...');
    smsCode = await s.pollSmsCode();
    console.log(`[ig] SMS code: ${smsCode}`);
    if (smsCode && smsCode !== 'no code received') {
      await s.fill('Confirmation code', smsCode).catch(() => {});
      await sleep(1);
      await s.click('Continue').catch(() => {});
      await sleep(5);
      for (let w = 0; w < 10; w++) { await sleep(2); const tt = await readPage(s); if (!tt.includes('confirmation')) { console.log(`[ig] code accepted`); break; } }
    } else { console.log('[ig] no SMS code — will retry with new number'); }
  }

  // Handle "confirm you're human" captcha or skip onboarding
  for (let i = 0; i < 30; i++) {
    if (s.page.isClosed?.()) { console.log('[ig] page closed'); throw new Error('page_closed'); }
    const url = s.page.url?.() ?? '';
    const t = await readPage(s);
    console.log(`[ig] onboarding ${i}: url=${url.slice(-30)} text=${t.slice(0, 60).replace(/\n/g, ' ')}`);
    if (url.includes('/explore') || url.includes('/direct') || url.includes('/accounts/onetap') || t.includes('suggested for you')) break;
    // Password reset page — dead end, account wasn't created properly
    if (url.includes('/password/reset') || t.includes('find your account')) {
      console.log('[ig] redirected to password reset — account not created');
      throw new Error('password_reset_redirect');
    }
    // Still on confirmation code page — re-enter code and click Submit
    if ((t.includes('confirmation code') || t.includes('enter the 6-digit')) && smsCode) {
      await s.fill('Confirmation code', smsCode).catch(() => {});
      await sleep(1);
      await s.click('Continue').catch(() => {});
      await sleep(5);
      const pt = await readPage(s);
      console.log(`[ig] code submit: ${pt.slice(0, 120).replace(/\n/g, ' ')}`);
      continue;
    }
    // Selfie verification — can't bypass, must retry
    if (t.includes('verification selfie') || t.includes('upload a photo that clearly')) {
      console.log('[ig] selfie verification required — cannot automate, retrying');
      throw new Error('selfie_required');
    }
    // Phone verification — only on /suspended/ page, NOT on password reset
    if ((t.includes('mobile number') || t.includes('enter your mobile')) && url.includes('/suspended') && !t.includes('find your account')) {
      console.log('[ig] phone verification required');
      // Keep trying different numbers until one delivers — alternate US/UK
      for (let phoneAttempt = 0; ; phoneAttempt++) {
        if (s.page.isClosed?.()) break;
        const country = phoneAttempt % 2 === 0 ? 'US' : 'UK';
        const phone = await s.checkSms('instagram', country);
        console.log(`[ig] SMS attempt ${phoneAttempt + 1} (${country}): ${phone}`);
        if (phone.startsWith('error')) { await sleep(5); continue; }
        const phoneNum = s.resolveEnv('$INSTAGRAM_NEW_PHONE');
        // Strip country prefix to get raw digits
        const digits = phoneNum.replace(/^\+\d{1,2}/, '').replace(/\D/g, '');
        console.log(`[ig] phone digits: ${digits} (country: ${country})`);
        // If non-US country, try to change country selector
        if (country !== 'US') {
          // Instagram uses a custom dropdown — try clicking the country code area and selecting
          await s.page.evaluate(`((cc) => {
            var selects = document.querySelectorAll('select');
            for (var sel of selects) {
              for (var opt of sel.options) {
                if (opt.value && opt.value.includes(cc === 'UK' ? '44' : cc === 'NL' ? '31' : cc === 'DE' ? '49' : '1')) {
                  sel.value = opt.value;
                  sel.dispatchEvent(new Event('change', {bubbles:true}));
                  break;
                }
              }
            }
          })("${country}")`).catch(() => {});
          await sleep(1);
        }
        // Clear and type phone via shared atoms
        const telLoc = s.page.locator('input[type="tel"]').first();
        if (await telLoc.count()) await humanFill(s.page, telLoc, '').catch(() => {});
        await sleep(1);
        await humanType(s.page, digits).catch(() => {});
        await sleep(1);
        // Instagram's heavy page crashes on mouse.move, so the Send Code /
        // Next / Continue button goes via s.jsClick (named escape-hatch atom).
        for (const t of ['send', 'continue', 'next']) { if (!/no-element-found/.test(await s.jsClick('[role="button"]', t).catch(() => 'no-element-found'))) break; }
        await sleep(5);
        const smsCode = await s.pollSmsCode();
        console.log(`[ig] SMS code: ${smsCode}`);
        if (smsCode && smsCode !== 'no code received' && !s.page.isClosed?.()) {
          console.log(`[ig] filling SMS code ${smsCode}`);
          await s.page.evaluate(`((code) => { var inp = document.querySelector('input[maxlength="6"]'); if (!inp) { var inputs = Array.from(document.querySelectorAll('input[type="text"]')); inp = inputs.find(i => !i.disabled && !i.value && i.offsetParent); } if (inp) { var set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(inp, code); inp.dispatchEvent(new Event('input', {bubbles:true})); inp.dispatchEvent(new Event('change', {bubbles:true})); } })("${smsCode}")`).catch(() => {});
          await sleep(2);
          // Confirm SMS code (Next / Continue / Confirm) via s.jsClick
          for (const t of ['confirm', 'continue', 'next']) { if (!/no-element-found/.test(await s.jsClick('[role="button"]', t).catch(() => 'no-element-found'))) break; }
          await sleep(5);
          break;
        }
        // Back button to re-enter a different number
        await s.jsClick('[aria-label="Back"], [aria-label="Go back"]').catch(() => {});
        await sleep(3);
      }
      continue;
    }
    // Image text captcha — screenshot the image, send to solver
    if (t.includes('confirm that you') || t.includes('enter the code from the image') || url.includes('/suspended')) {
      console.log('[ig] captcha page detected');
      // s.jsClick to avoid mouse.move crash on Instagram's heavy page.
      await s.jsClick('[role="button"]', 'continue').catch(() => {});
      await sleep(3);
      const t2 = await readPage(s);
      if (t2.includes('enter the code from the image') || t2.includes('hear this code')) {
        console.log('[ig] solving image captcha...');
        // Find the captcha image — pick the largest visible <img> on the page
        // The src*="captcha" selector sometimes matches tiny tracking pixels (400 chars base64)
        const imgEl = await s.page.evaluateHandle(`(() => {
          var imgs = Array.from(document.querySelectorAll('img'));
          var best = null, bestArea = 0;
          for (var img of imgs) {
            if (!img.offsetParent) continue;
            var w = img.naturalWidth || img.width || 0;
            var h = img.naturalHeight || img.height || 0;
            if (w * h > bestArea) { bestArea = w * h; best = img; }
          }
          return best;
        })()`).catch(() => null);
        const imgB64 = imgEl ? (await imgEl.asElement()?.screenshot({ type: 'png' }).catch(() => null))?.toString('base64') : null;
        if (imgB64 && imgB64.length > 500) {
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
    // Still on signup form — submission failed, bail early
    if (t.includes('get started on instagram') && i > 3) throw new Error('signup_form_stuck');
    // s.jsClick to skip onboarding (heavy page context).
    for (const t of ['skip', 'not now', 'next']) { if (!/no-element-found/.test(await s.jsClick('[role="button"], a[role="button"]', t).catch(() => 'no-element-found'))) break; }
    await sleep(2);
  }

  // Verify success: check URL and auth cookies
  if (s.page.isClosed?.()) throw new Error('page_closed');
  const finalUrl = s.page.url?.() ?? '';
  if (finalUrl.includes('/suspended')) throw new Error('account_suspended');
  const cookies = await s.ctx.cookies().catch(() => []);
  const authCookies = cookies.filter(c => c.domain?.includes('instagram.com') && (c.name === 'sessionid' || c.name === 'csrftoken'));
  if (authCookies.length < 2) {
    console.log(`[ig] no auth cookies (cookies=${authCookies.map(c => c.name)})`);
    throw new Error('no_auth_cookies');
  }
  console.log(`[ig] auth cookies verified: ${authCookies.map(c => c.name).join(', ')}`);

  // Save account
  const result = await s.saveAccount('instagram', {
    username: id.username, email: id.email, password: id.password, name, phone: phoneNum,
  });
  console.log(`[ig] ${result}`);
  return id.username;
}

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  console.log(`\n=== Instagram signup attempt ${attempt}/${MAX_RETRIES} ===`);
  const s = await WSession.start({ label: `instagram_register_${attempt}`, proxy, browser: 'chromium' });
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
