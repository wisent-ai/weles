// Request non-transfer access to an existing Meta ad account from Business Settings.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generatePersona } from '../../../dist/browser/persona.js';
import { WSession } from '../../../dist/session/wsession.js';

const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'meta_ads');
const BUSINESS_ID = process.env.META_BUSINESS_ID || process.env.BUSINESS_ID || '885982240795843';
const AD_ACCOUNT_ID = (process.env.AD_ACCOUNT_ID || process.env.META_AD_ACCOUNT_ID || '849988068092449').replace(/^act_/, '');
const WAIT_MS = Number(process.env.WAIT_MS || 2500);
mkdirSync(USER_DATA_DIR, { recursive: true });
process.env.WELES_VIEWPORT ??= '1440x1000';

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
      if (/token|code|secret|state|session|auth/i.test(key)) parsed.searchParams.set(key, '<redacted>');
    }
    return parsed.toString();
  } catch {
    return '<invalid-url>';
  }
}

async function snapshot(page, label) {
  await page.waitForTimeout(WAIT_MS).catch(() => {});
  const data = await page.evaluate((adAccountId) => {
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const fields = Array.from(document.querySelectorAll('input, textarea'))
      .filter(visible)
      .map((el) => ({
        value: el.value || '',
        placeholder: el.getAttribute('placeholder') || '',
      }));
    const controls = Array.from(document.querySelectorAll('button, [role="button"], a, [role="menuitem"], input, textarea, [aria-label]'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = textOf(el) || el.getAttribute('placeholder') || '';
        return {
          text: text.slice(0, 200),
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          placeholder: el.getAttribute('placeholder') || '',
          value: (el.value || '').slice(0, 200),
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      })
      .filter((item) => item.text || item.placeholder)
      .slice(0, 100);
    const bodyText = textOf(document.body);
    return {
      title: document.title || null,
      bodyText: bodyText.slice(0, 3000),
      controls,
      statusHints: {
        technicalError: /niespodziewany problem techniczny|unexpected technical problem|try again|spróbuj ponownie/i.test(bodyText),
        permissionDenied: /brak dostępu|permission denied|access denied|not authorized|nie masz dostępu|nie możesz poprosić|nie możesz uzyskać|odmówiono/i.test(bodyText),
        missingAdAccountId: /zanim przejdziesz dalej, dodaj identyfikator konta reklamowego|add the ad account id|enter an ad account id/i.test(bodyText),
        missingRole: /zanim przejdziesz dalej, wybierz rolę|choose a role|select a role/i.test(bodyText),
        requestFlowOpen: /request access to an ad account|poproś o dostęp do konta reklamowego|choose the role you need|wybierz role|wybierz rolę|wybierz konto reklamowe/i.test(bodyText),
        submitted: /wysłano|submitted|prośba została|request has been/i.test(bodyText),
        accountPresent: bodyText.includes(adAccountId) || fields.some((field) => field.value.includes(adAccountId)),
      },
    };
  }, AD_ACCOUNT_ID);
  console.log(JSON.stringify({
    stage: 'snapshot',
    label,
    url: sanitizedUrl(page.url?.() || ''),
    ...data,
  }, null, 2));
  return data;
}

async function clickFirst(page, label, allow, deny = /delete|remove|usuń|anuluj|cancel|zamknij|przenieś|transfer|utwórz nowe/i) {
  const target = await page.evaluate(({ allowSource, allowFlags, denySource, denyFlags }) => {
    const allowRe = new RegExp(allowSource, allowFlags);
    const denyRe = new RegExp(denySource, denyFlags);
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, [role="menuitem"], div, span'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = textOf(el);
        const area = rect.width * rect.height;
        let score = Math.max(0, 500000 - area);
        if (el.matches('button, [role="button"], a, [role="menuitem"]')) score += 100000;
        if (rect.left > 300) score += 10000;
        return {
          text,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          area,
          score,
        };
      })
      .filter((item) => item.area < 500000)
      .filter((item) => item.text && !item.disabled && allowRe.test(item.text) && !denyRe.test(item.text))
      .sort((a, b) => b.score - a.score);
    return nodes[0] || null;
  }, {
    allowSource: allow.source,
    allowFlags: allow.flags,
    denySource: deny.source,
    denyFlags: deny.flags,
  }).catch(() => null);
  if (!target) return null;
  await page.mouse.click(target.x, target.y, { delay: 50 });
  await page.waitForTimeout(1500).catch(() => {});
  console.log(JSON.stringify({ stage: 'clicked', label, text: target.text.slice(0, 180), x: target.x, y: target.y }));
  return target;
}

async function fillAdAccountId(page) {
  const x = Number(process.env.META_AD_ACCOUNT_FIELD_X || 820);
  const y = Number(process.env.META_AD_ACCOUNT_FIELD_Y || 337);
  await page.mouse.click(x, y, { delay: 50 });
  await page.keyboard.press('ControlOrMeta+A').catch(() => {});
  await page.keyboard.type(AD_ACCOUNT_ID, { delay: 20 }).catch(async () => {
    await page.keyboard.insertText(AD_ACCOUNT_ID).catch(() => {});
  });
  console.log(JSON.stringify({ stage: 'filled_ad_account_id', adAccountId: AD_ACCOUNT_ID, x, y }));
  await page.waitForTimeout(1200).catch(() => {});
}

async function clickEnabledDialogAction(page, label, allow) {
  const target = await page.evaluate(({ allowSource, allowFlags }) => {
    const allowRe = new RegExp(allowSource, allowFlags);
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], a'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: textOf(el),
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          top: rect.top,
          left: rect.left,
        };
      })
      .filter((item) => item.text && allowRe.test(item.text) && !item.disabled)
      .sort((a, b) => (b.top - a.top) || (b.left - a.left));
    return nodes[0] || null;
  }, {
    allowSource: allow.source,
    allowFlags: allow.flags,
  }).catch(() => null);
  if (!target) return null;
  await page.mouse.click(target.x, target.y, { delay: 50 });
  await page.waitForTimeout(1500).catch(() => {});
  console.log(JSON.stringify({ stage: 'clicked', label, text: target.text.slice(0, 180), x: target.x, y: target.y }));
  return target;
}

async function selectRole(page) {
  const target = await page.evaluate(() => {
    const allowRe = /zarządzaj kontami reklamowymi|manage ad accounts|admin access|pełny dostęp|full access/i;
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const nodes = Array.from(document.querySelectorAll('[role="switch"], input[type="checkbox"], button, [role="button"]'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: textOf(el),
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          checked: el.checked === true || el.getAttribute('aria-checked') === 'true' || el.value === 'true',
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
        };
      })
      .filter((item) => item.text && allowRe.test(item.text) && !item.disabled)
      .sort((a, b) => {
        const aSwitch = /switch|checkbox/i.test(a.role) ? 1 : 0;
        const bSwitch = /switch|checkbox/i.test(b.role) ? 1 : 0;
        return (bSwitch - aSwitch) || (b.y - a.y);
      });
    return nodes[0] || null;
  }).catch(() => null);
  if (!target) return null;
  if (!target.checked) await page.mouse.click(target.x, target.y, { delay: 50 });
  await page.waitForTimeout(1500).catch(() => {});
  console.log(JSON.stringify({ stage: 'selected_role', text: target.text.slice(0, 180), x: target.x, y: target.y, alreadyChecked: target.checked }));
  return target;
}

console.log(JSON.stringify({
  stage: 'start',
  userDataDir: USER_DATA_DIR,
  businessId: BUSINESS_ID,
  adAccountId: AD_ACCOUNT_ID,
  headless: process.env.META_BUSINESS_HEADLESS !== '0',
}, null, 2));

const s = await WSession.start({
  label: 'meta_business_request_ad_account_access',
  browser: process.env.BROWSER || 'chromium',
  proxy: process.env.PROXY_URL || 'direct',
  persona: stableProfilePersona(),
  userDataDir: USER_DATA_DIR,
  headless: process.env.META_BUSINESS_HEADLESS !== '0',
  pageDiagnostics: process.env.WELES_PAGE_DIAGNOSTICS === '1',
});

let exitCode = 0;
try {
  const url = `https://business.facebook.com/latest/settings/ad_accounts?business_id=${encodeURIComponent(BUSINESS_ID)}`;
  await s.page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await snapshot(s.page, 'initial_ad_accounts');
  await clickFirst(s.page, 'add', /^add$|^dodaj$/i);
  await snapshot(s.page, 'add_menu');
  const choseRequest = await clickFirst(
    s.page,
    'request_access',
    /poproś o dostęp do konta reklamowego|request access to an ad account|uzyskaj dostęp do konta reklamowego/i,
  );
  if (!choseRequest) throw new Error('Meta did not expose the non-transfer ad-account access request option');
  await snapshot(s.page, 'request_form');
  await fillAdAccountId(s.page);
  const filled = await snapshot(s.page, 'ad_account_id_filled');
  if (filled.statusHints.missingAdAccountId || !filled.statusHints.accountPresent) {
    throw new Error(`Meta did not accept ad-account id ${AD_ACCOUNT_ID} in the request form`);
  }
  const next = await clickEnabledDialogAction(s.page, 'next_or_submit', /^dalej$|^next$|^wyślij prośbę$|^send request$|^poproś o dostęp$|^request access$/i);
  if (!next) throw new Error('Meta did not expose an enabled ad-account access request submit button');
  let result = await snapshot(s.page, 'after_submit');
  if (result.statusHints.missingAdAccountId) throw new Error(`Meta still requires an ad-account id after submitting ${AD_ACCOUNT_ID}`);
  if (result.statusHints.technicalError) throw new Error(`Meta returned a technical error requesting ad account ${AD_ACCOUNT_ID}`);
  if (result.statusHints.permissionDenied) throw new Error(`Meta refused ad-account access request for ${AD_ACCOUNT_ID}`);
  if (result.statusHints.missingRole || /choose the role you need|wybierz rolę|wybierz role/i.test(result.bodyText)) {
    const role = await selectRole(s.page);
    if (!role) throw new Error('Meta did not expose an ad-account role control to select');
    await snapshot(s.page, 'role_selected');
    const confirm = await clickEnabledDialogAction(s.page, 'confirm_request', /^potwierdź$|^confirm$|^wyślij prośbę$|^send request$/i);
    if (!confirm) throw new Error('Meta did not expose an enabled confirmation button after selecting a role');
    result = await snapshot(s.page, 'after_confirm');
    if (result.statusHints.missingRole) throw new Error(`Meta still requires an ad-account role after selecting one for ${AD_ACCOUNT_ID}`);
    if (result.statusHints.technicalError) throw new Error(`Meta returned a technical error confirming ad-account request for ${AD_ACCOUNT_ID}`);
    if (result.statusHints.permissionDenied) throw new Error(`Meta refused confirmed ad-account access request for ${AD_ACCOUNT_ID}`);
    if (result.statusHints.requestFlowOpen && !result.statusHints.submitted) {
      throw new Error(`Meta kept the ad-account request dialog open after confirmation for ${AD_ACCOUNT_ID}`);
    }
  }
  console.log('PASS: Meta ad-account access request flow submitted');
} catch (error) {
  exitCode = 1;
  console.log(`FAIL: ${error.message || String(error)}`);
} finally {
  await s.close().catch(() => {});
}

if (exitCode) process.exit(exitCode);
