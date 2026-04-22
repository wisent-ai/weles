import { WSession } from '../../../dist/session/wsession.js';
import { findActiveAccount, injectCookies, clearCaptchaInPlainBrowser } from './_session.mjs';

// Fill a Product Hunt user profile (headline, about, location, website).
// Two-phase to avoid running two heavy chromium processes in parallel:
//   1. Probe with a minimal WSession; if we hit /login or /captcha_verification,
//      close it before launching the captcha-clear browser.
//   2. Captcha-clear runs in a plain weles browser (no WSession overhead) so
//      Playwright's CDP connection survives the reCAPTCHA iframe.
//   3. Re-open WSession with cleared cookies and fill the form.

const EDIT_URL = 'https://www.producthunt.com/my/details/edit';
const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

const HEADLINE = process.env.PH_HEADLINE || 'Indie hacker exploring product-led growth';
const ABOUT = process.env.PH_BIO || 'Building, breaking, and shipping side projects. Always curious about what makes products spread.';
const LOCATION = process.env.PH_LOCATION || 'Remote';
const WEBSITE = process.env.PH_WEBSITE || '';

async function probeFields(page) {
  return await page.evaluate(`(() => {
    var out = [];
    document.querySelectorAll('input, textarea').forEach(function(el) {
      var rect = el.getBoundingClientRect();
      if (rect.width < 5 || rect.height < 5) return;
      var name = el.getAttribute('name') || '';
      var id = el.id || '';
      var ph = el.getAttribute('placeholder') || '';
      var aria = el.getAttribute('aria-label') || '';
      var type = el.getAttribute('type') || el.tagName.toLowerCase();
      var labelText = '';
      if (id) { var l = document.querySelector('label[for="' + id + '"]'); if (l) labelText = (l.textContent || '').trim(); }
      out.push({ name: name, id: id, type: type, placeholder: ph, aria: aria, label: labelText, value: (el.value || '').slice(0, 80) });
    });
    return out;
  })()`).catch(() => []);
}

async function fillField(page, field, value) {
  const selector = field.id ? '#' + field.id
    : field.name ? '[name="' + field.name + '"]'
    : field.placeholder ? '[placeholder="' + field.placeholder + '"]'
    : null;
  if (!selector) return false;
  return await page.evaluate(`(() => {
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    var setter = Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`).catch(() => false);
}

function pickValue(field) {
  const haystack = (field.name + ' ' + field.id + ' ' + field.placeholder + ' ' + field.aria + ' ' + field.label).toLowerCase();
  if (/headline|tagline|short.*bio/.test(haystack)) return HEADLINE;
  if (/about|bio|description|tell us|tell people/.test(haystack)) return ABOUT;
  if (/location|city|country|where/.test(haystack)) return LOCATION;
  if (/website|url|link|homepage/.test(haystack)) return WEBSITE || null;
  return null;
}

async function openSessionAndFill(cookies) {
  const proxy = process.env.PROXY_URL || 'none';
  const s = await WSession.start({ label: 'producthunt_profile', proxy, record: false });
  try {
    await injectCookies(s.ctx, cookies, '.producthunt.com');
    await s.page.goto(EDIT_URL, { waitUntil: 'domcontentloaded' });
    await sleep(4);
    const cur = s.page.url();
    console.log(`[ph-profile] edit page nav: ${cur}`);
    if (cur.includes('/login') || cur.includes('/captcha_verification')) {
      throw new Error(`still_blocked_at_${cur.split('/').pop()}`);
    }
    // Wait for React form to render
    await s.page.waitForSelector('input[type="text"], textarea').catch(() => {});
    await sleep(3);

    const fields = await probeFields(s.page);
    console.log(`[ph-profile] discovered ${fields.length} editable fields`);
    for (const f of fields) {
      console.log(`  - ${f.type} name="${f.name}" id="${f.id}" label="${f.label}" value="${f.value}"`);
    }
    const profileFields = fields.filter(f => pickValue(f) !== null);
    if (profileFields.length === 0) throw new Error(`no_profile_fields_on_page: fieldCount=${fields.length}`);
    console.log(`[ph-profile] ${profileFields.length} matched profile fields`);

    let touched = 0;
    for (const f of fields) {
      if ((f.value || '').trim().length > 0) continue;
      const value = pickValue(f);
      if (!value) continue;
      const ok = await fillField(s.page, f, value);
      console.log(`[ph-profile] fill ${f.name || f.id} = "${value.slice(0, 40)}" -> ${ok}`);
      if (ok) touched++;
      await sleep(1);
    }

    if (touched === 0) {
      console.log('[ph-profile] no blank fields — already populated');
      return true;
    }

    const saved = await s.page.evaluate(`(() => {
      var btns = Array.from(document.querySelectorAll('button[type="submit"], button'));
      for (var b of btns) {
        var t = (b.textContent || '').trim().toLowerCase();
        if (t === 'save' || t === 'save changes' || t === 'update') { b.scrollIntoView({block:'center'}); b.click(); return t; }
      }
      return null;
    })()`).catch(() => null);
    console.log(`[ph-profile] save click: ${saved}`);
    await sleep(5);

    const fields2 = await probeFields(s.page);
    const stillBlank = fields2.filter(f => (f.value || '').trim().length === 0 && pickValue(f));
    if (stillBlank.length > 0) throw new Error(`save_did_not_persist: stillBlank=${stillBlank.map(f => f.name || f.id).join(',')}`);
    return true;
  } finally {
    await s.close().catch(() => {});
  }
}

async function fillProfile() {
  const acct = await findActiveAccount('producthunt');
  if (!acct) throw new Error('no_producthunt_account_in_db');
  let cookies = acct.metadata?.cookies ?? [];
  console.log(`[ph-profile] using account: ${acct.username} (${cookies.length} cookies)`);
  if (cookies.length < 1) throw new Error('producthunt_account_missing_cookies');

  // First attempt: existing cookies might already give SSR access
  try {
    await openSessionAndFill(cookies);
    return acct.username;
  } catch (e) {
    if (!e.message?.startsWith('still_blocked_at_')) throw e;
    console.log(`[ph-profile] existing cookies blocked: ${e.message} — clearing captcha in plain browser`);
  }

  // Captcha clear runs alone — no WSession competing for resources
  const tw = await findActiveAccount('twitter');
  if (!tw) throw new Error('no_twitter_account_for_captcha_clear');
  const twCookies = tw.metadata?.cookies ?? [];
  cookies = await clearCaptchaInPlainBrowser(cookies, twCookies);
  console.log(`[ph-profile] captcha cleared, got ${cookies.length} fresh cookies`);

  // Second attempt with the cleared cookies
  await openSessionAndFill(cookies);
  return acct.username;
}

try {
  const username = await fillProfile();
  console.log(`PASS: ${username} profile saved`);
  process.exit(0);
} catch (e) {
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  process.exit(1);
}
