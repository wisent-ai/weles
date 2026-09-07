// Continue Meta developer account verification by opening the Accounts Center
// link required for SMS confirmation. Does not accept legal terms or submit
// phone/card details.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generatePersona } from '../../../dist/browser/persona.js';
import { WSession } from '../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { humanFill, humanType } from '../../../dist/human/keyboard.js';

const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'meta_ads');
const WAIT_MS = Number(process.env.WAIT_MS || 3000);
let VERIFY_PHONE = process.env.META_VERIFY_PHONE || '';
const VERIFY_CODE = process.env.META_VERIFY_CODE || '';
const CODE_ONLY = process.env.META_VERIFY_CODE_ONLY === '1';
const OPEN_UPDATE_PHONE = process.env.META_VERIFY_OPEN_UPDATE_PHONE === '1';
const VERIFY_PHONE_FROM_ACCOUNT_COUNTRY = process.env.META_VERIFY_PHONE_FROM_ACCOUNT_COUNTRY || '';
mkdirSync(USER_DATA_DIR, { recursive: true });
process.env.WELES_VIEWPORT ??= '1280x900';

function stableProfilePersona() {
  const p = join(USER_DATA_DIR, 'persona.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const persona = generatePersona({ os: 'macos', browser: 'chromium' });
  writeFileSync(p, JSON.stringify(persona, null, 2));
  return persona;
}

function sanitizedUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = parsed.hash ? '#<redacted>' : '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|code|secret|state|session|auth|code/i.test(key)) parsed.searchParams.set(key, '<redacted>');
    }
    return parsed.toString();
  } catch {
    return '<invalid-url>';
  }
}

async function bringBrowserToFront(s) {
  await s.page.bringToFront().catch(() => {});
  if (process.platform !== 'darwin') return;
  spawnSync('osascript', ['-e', 'tell application "Chromium" to activate'], { stdio: 'ignore' });
  spawnSync('osascript', ['-e', 'tell application "System Events" to set frontmost of every process whose name is "Chromium" to true'], { stdio: 'ignore' });
}

async function snapshot(page, label) {
  await page.waitForTimeout(WAIT_MS).catch(() => {});
  const data = await page.evaluate(() => {
    const textOf = (el) => {
      if (!el) return '';
      return (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    };
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const bodyText = textOf(document.body);
    const controls = Array.from(document.querySelectorAll('button, [role="button"], a, [role="menuitem"], input, textarea, select, [aria-label]'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: (textOf(el) || el.getAttribute('placeholder') || '').slice(0, 180),
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          href: el.getAttribute('href') || '',
          placeholder: el.getAttribute('placeholder') || '',
          type: el.getAttribute('type') || '',
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      })
      .filter((item) => item.text || item.href || item.placeholder)
      .slice(0, 100);
    return {
      title: document.title || null,
      bodyText: bodyText.slice(0, 2200),
      controls,
      statusHints: {
        initialTerms: /By proceeding, you agree to the Meta's Platform Terms and Developer Policies/i.test(bodyText),
        phoneStep: /Verify Your Account|Mobile number|Send Verification SMS/i.test(bodyText),
        accountsCenterRequired: /only complete this action in Accounts Center|Go to Accounts Center/i.test(bodyText),
        accountsCenter: /Accounts Center|Account settings|Personal details/i.test(bodyText),
        smsCode: /verification code|confirmation code|SMS code|security code|kod/i.test(bodyText),
      },
    };
  });
  console.log(JSON.stringify({
    stage: 'snapshot',
    label,
    url: sanitizedUrl(page.url?.() || ''),
    ...data,
    controls: data.controls.map((control) => ({ ...control, href: sanitizedUrl(control.href) })),
  }, null, 2));
  return data;
}

function normalizePhone(raw) {
  const phone = String(raw || '').trim();
  const digits = phone.replace(/\D/g, '');
  if (!digits) return null;
  return {
    phone,
    country: digits.startsWith('48') ? '+48' : digits.startsWith('1') ? '+1' : 'unknown',
    suffix: digits.slice(-2),
    digitCount: digits.length,
  };
}

function phoneCountry(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('48')) return '+48';
  if (digits.startsWith('1')) return '+1';
  return 'unknown';
}

function phoneNationalNumber(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('48')) return digits.slice(2);
  if (digits.startsWith('1')) return digits.slice(1);
  return digits;
}

async function clickVisibleText(page, label, allow, includeDivs = false) {
  const selector = includeDivs
    ? 'button, [role="button"], [role="combobox"], [aria-haspopup], a, div, span'
    : 'button, [role="button"], [role="combobox"], [aria-haspopup], a';
  const target = await page.evaluate(({ selector, allowSource, allowFlags }) => {
    const allowRe = new RegExp(allowSource, allowFlags);
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll(selector))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: textOf(el),
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          area: rect.width * rect.height,
        };
      })
      .filter((item) => item.text && !item.disabled && allowRe.test(item.text))
      .sort((a, b) => a.area - b.area);
    return candidates[0] || null;
  }, {
    selector,
    allowSource: allow.source,
    allowFlags: allow.flags,
  }).catch(() => null);
  if (!target) return null;
  await page.mouse.click(target.x, target.y, { delay: 50 });
  await page.waitForTimeout(WAIT_MS).catch(() => {});
  console.log(JSON.stringify({ stage: 'clicked', label, text: target.text.slice(0, 80), x: target.x, y: target.y }));
  return target;
}

async function selectCountryForPhone(page, phone) {
  if (phoneCountry(phone) !== '+48') return false;
  const opened = await clickVisibleText(page, 'country_selector', /United States\s*\(\+1\)|Country\s+United States/i, true);
  if (!opened) return false;
  let selected = await clickVisibleText(page, 'country_poland', /Poland\s*\(\+48\)|Polska\s*\(\+48\)/i, true);
  if (!selected) {
    await humanType(page, 'Poland').catch(() => {});
    await page.waitForTimeout(1000).catch(() => {});
    selected = await clickVisibleText(page, 'country_poland_after_search', /Poland\s*\(\+48\)|Polska\s*\(\+48\)/i, true);
  }
  return Boolean(selected);
}

async function loadAccountPhone(page, preferredCountry) {
  await page.goto('https://accountscenter.facebook.com/youraccount/contact_points/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(WAIT_MS).catch(() => {});
  const rawPhones = await page.evaluate(() => {
    const textOf = (el) => [
      el.innerText || '',
      el.textContent || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
    ].join(' ');
    const text = [
      document.body?.innerText || '',
      document.body?.textContent || '',
      ...Array.from(document.querySelectorAll('button, [role="button"], a, input, [aria-label], [title]')).map(textOf),
    ].join(' ');
    const matches = text.match(/\+\d[\d\s().-]{6,}\d/g) || [];
    return Array.from(new Set(matches));
  });
  const candidates = rawPhones
    .map(normalizePhone)
    .filter(Boolean)
    .sort((a, b) => {
      if (a.country === preferredCountry && b.country !== preferredCountry) return -1;
      if (b.country === preferredCountry && a.country !== preferredCountry) return 1;
      return b.digitCount - a.digitCount;
    });
  const selected = candidates[0] || null;
  if (!selected) return null;
  console.log(JSON.stringify({
    stage: 'account_phone_candidate_loaded',
    country: selected.country,
    suffix: selected.suffix,
    digitCount: selected.digitCount,
    nationalDigitCount: phoneNationalNumber(selected.phone).length,
    candidates: candidates.length,
  }, null, 2));
  return selected.phone;
}

async function clickAccountsCenter(page) {
  const target = await page.evaluate(() => {
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll('a, button, [role="button"]'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: textOf(el),
          href: el.getAttribute('href') || '',
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      })
      .filter((item) => !item.disabled && /Accounts Center/i.test(item.text));
    return candidates[0] || null;
  });
  if (!target) return null;
  await page.mouse.click(target.x, target.y, { delay: 50 });
  await page.waitForTimeout(WAIT_MS).catch(() => {});
  console.log(JSON.stringify({ stage: 'clicked', label: 'accounts_center', text: target.text, href: sanitizedUrl(target.href), x: target.x, y: target.y }));
  return target;
}

async function fillPhoneAndSend(page) {
  if (!VERIFY_PHONE) return { filled: false, clicked: false };
  const countryChanged = await selectCountryForPhone(page, VERIFY_PHONE);
  if (countryChanged) {
    await snapshot(page, 'after_country_select');
  }
  const input = page.locator('input[placeholder*="phone" i], input[aria-label*="phone" i], input[placeholder*="mobile" i], input[aria-label*="mobile" i], input[type="tel"]').filter({ visible: true }).last();
  if (!await input.isVisible().catch(() => false)) return { filled: false, clicked: false };
  const inputValue = phoneNationalNumber(VERIFY_PHONE) || VERIFY_PHONE;
  const rect = await input.boundingBox().catch(() => null);
  if (rect) await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2, { delay: 50 }).catch(() => {});
  await input.focus().catch(() => {});
  await page.keyboard.press('ControlOrMeta+A').catch(() => {});
  await humanType(page, inputValue).catch(async () => {
    await humanFill(page, input, inputValue).catch(() => {});
  });
  await input.dispatchEvent('input').catch(() => {});
  await input.dispatchEvent('change').catch(() => {});
  await page.waitForTimeout(1000).catch(() => {});
  let inputState = await input.evaluate((el) => {
    const digits = (el.value || '').replace(/\D/g, '');
    return {
      valueLength: digits.length,
      valueSuffix: digits.slice(-2),
      placeholder: el.getAttribute('placeholder') || '',
      type: el.getAttribute('type') || '',
      maxLength: el.maxLength,
    };
  }).catch(() => ({ valueLength: null, valueSuffix: null, placeholder: '', type: '', maxLength: null }));
  if (inputState.valueLength === 0) {
    await input.evaluate((el, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, inputValue).catch(() => {});
    await page.waitForTimeout(1000).catch(() => {});
    inputState = await input.evaluate((el) => {
      const digits = (el.value || '').replace(/\D/g, '');
      return {
        valueLength: digits.length,
        valueSuffix: digits.slice(-2),
        placeholder: el.getAttribute('placeholder') || '',
        type: el.getAttribute('type') || '',
        maxLength: el.maxLength,
      };
    }).catch(() => ({ valueLength: null, valueSuffix: null, placeholder: '', type: '', maxLength: null }));
  }
  console.log(JSON.stringify({
    stage: 'filled_phone_input',
    valueLength: inputState.valueLength,
    valueSuffix: inputState.valueSuffix,
    placeholder: inputState.placeholder,
    type: inputState.type,
    maxLength: inputState.maxLength,
  }));
  const clicked = await page.evaluate(() => {
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: textOf(el),
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      })
      .filter((item) => !item.disabled && /Send Verification SMS/i.test(item.text));
    return candidates[0] || null;
  });
  if (!clicked) return { filled: true, clicked: false };
  await page.mouse.click(clicked.x, clicked.y, { delay: 50 });
  await page.waitForTimeout(WAIT_MS).catch(() => {});
  console.log(JSON.stringify({ stage: 'clicked', label: 'send_verification_sms', text: clicked.text, x: clicked.x, y: clicked.y }));
  return { filled: true, clicked: true };
}

async function clickUpdateMobileNumber(page) {
  const target = await page.evaluate(() => {
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: textOf(el),
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      })
      .filter((item) => !item.disabled && /Update Mobile Number|Zaktualizuj numer|Zmień numer/i.test(item.text));
    return candidates[0] || null;
  });
  if (!target) return null;
  await page.mouse.click(target.x, target.y, { delay: 50 });
  await page.waitForTimeout(WAIT_MS).catch(() => {});
  console.log(JSON.stringify({ stage: 'clicked', label: 'update_mobile_number', text: target.text, x: target.x, y: target.y }));
  return target;
}

async function fillCodeAndContinue(page) {
  if (!VERIFY_CODE) return { filled: false, clicked: false };
  const input = page.locator('input').filter({ visible: true }).last();
  if (!await input.isVisible().catch(() => false)) return { filled: false, clicked: false };
  await humanClickLocator(page, input).catch(() => {});
  await page.keyboard.press('ControlOrMeta+A').catch(() => {});
  await humanType(page, VERIFY_CODE).catch(async () => {
    await page.keyboard.insertText(VERIFY_CODE).catch(() => {});
  });
  await page.waitForTimeout(1000).catch(() => {});
  const clicked = await page.evaluate(() => {
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: textOf(el),
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      })
      .filter((item) => !item.disabled && /^(Continue|Kontynuuj|Dalej)$/i.test(item.text));
    return candidates[0] || null;
  });
  if (!clicked) return { filled: true, clicked: false };
  await page.mouse.click(clicked.x, clicked.y, { delay: 50 });
  await page.waitForTimeout(WAIT_MS).catch(() => {});
  console.log(JSON.stringify({ stage: 'clicked', label: 'developer_code_continue', text: clicked.text, x: clicked.x, y: clicked.y }));
  return { filled: true, clicked: true };
}

console.log(JSON.stringify({
  stage: 'start',
  userDataDir: USER_DATA_DIR,
  headless: process.env.META_VERIFY_HEADLESS === '1',
}, null, 2));

const s = await WSession.start({
  label: 'meta_developer_account_verification_accounts_center',
  browser: process.env.BROWSER || 'chromium',
  proxy: process.env.PROXY_URL || 'direct',
  persona: stableProfilePersona(),
  userDataDir: USER_DATA_DIR,
  headless: process.env.META_VERIFY_HEADLESS === '1',
  pageDiagnostics: process.env.WELES_PAGE_DIAGNOSTICS === '1',
});

let exitCode = 0;
try {
  let finishedDeveloperCode = false;
  await bringBrowserToFront(s);
  if (!VERIFY_PHONE && VERIFY_PHONE_FROM_ACCOUNT_COUNTRY) {
    VERIFY_PHONE = await loadAccountPhone(s.page, VERIFY_PHONE_FROM_ACCOUNT_COUNTRY) || '';
  }
  await s.page.goto('https://developers.facebook.com/async/developer/account/verification/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  const initial = await snapshot(s.page, 'initial');
  if (initial.statusHints.initialTerms && !initial.statusHints.phoneStep) {
    throw new Error('Meta is on the terms/registration screen; explicit user acceptance is required before continuing');
  }
  if (OPEN_UPDATE_PHONE) {
    const clicked = await clickUpdateMobileNumber(s.page);
    if (!clicked) throw new Error('No Update Mobile Number control found');
    const updateState = await snapshot(s.page, 'after_update_mobile_number');
    if (VERIFY_PHONE && updateState.statusHints.phoneStep) {
      const phoneResult = await fillPhoneAndSend(s.page);
      console.log(JSON.stringify({ stage: 'phone_submit_attempted', filled: phoneResult.filled, clicked: phoneResult.clicked }, null, 2));
      await snapshot(s.page, 'after_updated_phone_submit');
    }
    await bringBrowserToFront(s);
    finishedDeveloperCode = true;
  }
  if (!finishedDeveloperCode && (initial.statusHints.smsCode || CODE_ONLY)) {
    if (!initial.statusHints.smsCode) throw new Error('No developer verification code screen found for META_VERIFY_CODE_ONLY=1');
    if (!VERIFY_CODE) {
      console.log('NEED_CODE: META_VERIFY_CODE is required to submit the developer verification code');
      await bringBrowserToFront(s);
      throw new Error('Developer verification code required');
    }
    const codeResult = await fillCodeAndContinue(s.page);
    console.log(JSON.stringify({ stage: 'developer_code_submit_attempted', filled: codeResult.filled, clicked: codeResult.clicked }, null, 2));
    await snapshot(s.page, 'after_developer_code_submit');
    await bringBrowserToFront(s);
    finishedDeveloperCode = true;
  }
  if (!finishedDeveloperCode && initial.statusHints.phoneStep && !initial.statusHints.accountsCenterRequired) {
    const phoneResult = await fillPhoneAndSend(s.page);
    console.log(JSON.stringify({ stage: 'phone_submit_attempted', filled: phoneResult.filled, clicked: phoneResult.clicked }, null, 2));
    const afterPhone = await snapshot(s.page, 'after_phone_submit');
    if (afterPhone.statusHints.smsCode) {
      if (!VERIFY_CODE) {
        console.log('NEED_CODE: META_VERIFY_CODE is required to submit the developer verification code');
        await bringBrowserToFront(s);
        throw new Error('Developer verification code required');
      }
      const codeResult = await fillCodeAndContinue(s.page);
      console.log(JSON.stringify({ stage: 'developer_code_submit_attempted', filled: codeResult.filled, clicked: codeResult.clicked }, null, 2));
      await snapshot(s.page, 'after_developer_code_submit');
      await bringBrowserToFront(s);
      finishedDeveloperCode = true;
    }
  }
  if (!finishedDeveloperCode) {
    const clicked = await clickAccountsCenter(s.page);
    if (!clicked) throw new Error('No visible Accounts Center link found on the Meta verification page');
    await snapshot(s.page, 'after_accounts_center_click');
    await bringBrowserToFront(s);
  }
} catch (error) {
  exitCode = 1;
  console.log(`FAIL: ${error.message || String(error)}`);
} finally {
  await s.close().catch(() => {});
}

if (exitCode) process.exit(exitCode);
