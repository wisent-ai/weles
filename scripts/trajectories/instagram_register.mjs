import { WSession } from '../../dist/session/wsession.js';
import { humanType, humanFill } from '../../dist/human/keyboard.js';
import { humanIdlePause } from '../../dist/human/mouse.js';
import { autoBindCharacter } from './lib/character-bind.mjs';

const URL = 'https://www.instagram.com/accounts/emailsignup/';
const MAX_RETRIES = 5;
const USE_BRIGHTDATA = !!process.env.BRIGHTDATA_BROWSER_WS;
// Build US Oxylabs proxy URL directly — DB metadata routes to Brazil for Discord, but Instagram needs US
const oxyUser = process.env.OXYLABS_USERNAME;
const oxyPass = process.env.OXYLABS_PASSWORD;
const proxy = USE_BRIGHTDATA ? 'none' : (process.env.PROXY_URL || (oxyUser && oxyPass ? `http://customer-${oxyUser}-cc-us-sessid-${Math.floor(Math.random()*9999999)}:${oxyPass}@pr.oxylabs.io:7777` : 'none'));
const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));  // allow-raw-playwright: utility sleep shim — usages should migrate to humanIdlePause

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
  // IG validates this field against E.164: passing the raw 10-digit
  // national number trips the red "include the country code" banner
  // (verified 2026-05-19 frame f_020 of instagram_signup_probe). Pass
  // the full phoneNum which is already +<cc><number>; strip only spaces
  // and dashes the SMS provider may include.
  const digits = phoneNum.replace(/[^\d+]/g, '');

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

  // Fill signup form with phone number.
  // Selector targets updated 2026-05-19 from live frame evidence
  // (.work/instagram_signup_probe/frame_8ad8a66a_010.png): IG signup form
  // input name attributes drifted off "emailOrPhone" / "fullName"; wsFill's
  // selector fan-out finds the inputs by their visible label / placeholder
  // when target keywords match. Live form labels: "Mobile number or email
  // address" / "Password" / "Date of birth" / "Name" (placeholder
  // "Full name") / "Username".
  await s.fill('email', digits);
  await sleep(1);
  await s.fill('password', id.password);
  await sleep(1);
  // Date of birth — ARIA comboboxes with aria-haspopup=listbox and aria-labels
  // "Select day/month/year". The listbox is virtualized: only ~16 options render
  // at a time, so direct locator click on an off-window option times out on
  // "element is not visible" (verified 2026-05-19 frame 40+). s.select goes
  // through tryAriaCombobox which finds the matching combobox by aria-label
  // substring, scroll-and-clicks it, then either coordinate-clicks the option
  // if rendered or ArrowDown-walks the listbox until aria-selected matches.
  await s.select('Select day', id.birthDay);
  await humanIdlePause('short');
  await s.select('Select month', id.birthMonth);
  await humanIdlePause('short');
  await s.select('Select year', id.birthYear);
  await sleep(1);
  await s.fill('Full name', name);
  await sleep(1);
  await s.fill('username', id.username);
  await sleep(1);

  // Take screenshot before submit to verify form state
  await s.page.screenshot({ path: `/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/weles/recordings/ig_before_submit.png` }).catch(() => {});
  // Click Sign up — IG renders the submit control as
  // <div role="button" tabindex="0"> containing a <span>Submit</span>;
  // there are no <button> tags on the page (verified 2026-05-19 in
  // recordings/instagram_register_1/after_009_*_dom.html). The prior
  // `button[type="submit"]` selector silently matched a hidden iframe
  // submit and the real Submit was never clicked. s.click('Submit')
  // routes through wsClick which scans [role="button"] for visible
  // textContent + aria-label match and humanClickLocator's the hit.
  await s.click('Submit');
  await sleep(5);
  // Screenshot after submit
  await s.page.screenshot({ path: `/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/weles/recordings/ig_after_submit.png` }).catch(() => {});


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
    // Initial fill happens in the onboarding loop's code-page branch
    // (deduped — was duplicated here and below, both forgot the
    // 'no code received' sentinel check on re-entry).
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
    // Still on code page — re-enter, click Continue. Exclude the
    // 'no code received' sentinel: it gets truncated to 'no cod' and
    // burns the number across 30 retries (frame after_011).
    const codePage = t.includes('confirmation code') || t.includes('enter the 6-digit');
    if (codePage && smsCode && smsCode !== 'no code received') {
      await s.fill('Confirmation code', smsCode);
      await humanIdlePause('short');
      await s.click('Continue');
      await humanIdlePause('deliberate');
      console.log(`[ig] code submit: ${(await readPage(s)).slice(0, 120).replace(/\n/g, ' ')}`);
      continue;
    }
    if (codePage) throw new Error('sms_code_not_received');
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
        // Keep the country-code prefix — IG validates against E.164 on
        // both the initial signup field AND the /suspended re-entry
        // field. Strip only the separators the SMS provider may include.
        const digits = phoneNum.replace(/[^\d+]/g, '');
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
  await autoBindCharacter(id.username, 'instagram').then(r => console.log(`[bind] ${JSON.stringify(r)}`)).catch((e) => console.log(`[bind] err: ${e.message?.slice(0, 80)}`));
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
