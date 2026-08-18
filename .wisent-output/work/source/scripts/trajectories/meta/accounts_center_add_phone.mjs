// Add a phone contact in Accounts Center for Meta developer verification.
// Requires META_VERIFY_PHONE. If META_VERIFY_CODE is provided, submits the SMS code too.
// Phone and code values are not printed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generatePersona } from '../../../dist/browser/persona.js';
import { WSession } from '../../../dist/session/wsession.js';

const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'meta_ads');
const WAIT_MS = Number(process.env.WAIT_MS || 3000);
const VERIFY_PHONE = process.env.META_VERIFY_PHONE || '';
const VERIFY_CODE = process.env.META_VERIFY_CODE || '';
const CODE_ONLY = process.env.META_VERIFY_CODE_ONLY === '1';
if (!VERIFY_PHONE) {
  console.log('FAIL: META_VERIFY_PHONE is required');
  process.exit(1);
}
mkdirSync(USER_DATA_DIR, { recursive: true });
process.env.WELES_VIEWPORT ??= '1280x900';

function stableProfilePersona() {
  const p = join(USER_DATA_DIR, 'persona.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const persona = generatePersona({ os: 'macos', browser: 'chromium' });
  writeFileSync(p, JSON.stringify(persona, null, 2));
  return persona;
}

function sanitize(text) {
  return String(text || '')
    .replace(/\+\d[\d\s().-]{6,}\d/g, '<phone-redacted>')
    .replace(/\b\d{7,}\b/g, '<number-redacted>');
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
          text: (textOf(el) || el.getAttribute('placeholder') || '').slice(0, 200),
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
      .slice(0, 120);
    return {
      title: document.title || null,
      bodyText: bodyText.slice(0, 3200),
      controls,
      statusHints: {
        contactInfo: /Informacje kontaktowe|Contact info/i.test(bodyText),
        addContact: /Dodaj nowy kontakt|Add new contact/i.test(bodyText),
        phoneChoice: /Dodaj numer telefonu|Add.*phone|Mobile number|Numer telefonu/i.test(bodyText),
        code: /kod|code|SMS|confirmation/i.test(bodyText),
        error: /problem|error|nie można|cannot|invalid|nieprawidł/i.test(bodyText),
      },
    };
  });
  console.log(JSON.stringify({
    stage: 'snapshot',
    label,
    url: sanitizedUrl(page.url?.() || ''),
    title: data.title,
    bodyText: sanitize(data.bodyText),
    controls: data.controls.map((control) => ({
      ...control,
      text: sanitize(control.text),
      href: sanitizedUrl(control.href),
      placeholder: sanitize(control.placeholder),
    })),
    statusHints: data.statusHints,
  }, null, 2));
  return data;
}

async function clickFirst(page, label, allow, deny = /delete|remove|usuń|anuluj|cancel/i) {
  const target = await page.evaluate(({ allowSource, allowFlags, denySource, denyFlags }) => {
    const allowRe = new RegExp(allowSource, allowFlags);
    const denyRe = new RegExp(denySource, denyFlags);
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, [role="menuitem"]'))
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
      .filter((item) => item.text && !item.disabled && allowRe.test(item.text) && !denyRe.test(item.text))
      .sort((a, b) => a.area - b.area);
    return nodes[0] || null;
  }, {
    allowSource: allow.source,
    allowFlags: allow.flags,
    denySource: deny.source,
    denyFlags: deny.flags,
  }).catch(() => null);
  if (!target) return null;
  await page.mouse.click(target.x, target.y, { delay: 50 });
  await page.waitForTimeout(WAIT_MS).catch(() => {});
  console.log(JSON.stringify({ stage: 'clicked', label, text: sanitize(target.text), x: target.x, y: target.y }));
  return target;
}

async function waitAndClickFirst(page, label, allow, deny, attempts = 8) {
  for (let i = 0; i < attempts; i += 1) {
    const clicked = await clickFirst(page, label, allow, deny);
    if (clicked) return clicked;
    await page.waitForTimeout(1500).catch(() => {});
  }
  return null;
}

async function fillPhone(page) {
  const input = await page.locator('input[type="tel"], input[placeholder*="phone" i], input[aria-label*="phone" i], input[placeholder*="telefon" i], input[aria-label*="telefon" i], input[type="text"]').filter({ visible: true }).last();
  if (!await input.isVisible().catch(() => false)) return false;
  await input.click({ delay: 50 }).catch(() => {});
  await page.keyboard.press('ControlOrMeta+A').catch(() => {});
  await page.keyboard.type(VERIFY_PHONE, { delay: 20 }).catch(async () => {
    await page.keyboard.insertText(VERIFY_PHONE).catch(() => {});
  });
  await page.waitForTimeout(1000).catch(() => {});
  console.log(JSON.stringify({ stage: 'filled_phone', redacted: true }));
  return true;
}

async function fillCode(page) {
  if (!VERIFY_CODE) return false;
  const input = page.locator('input').filter({ visible: true }).last();
  if (!await input.isVisible().catch(() => false)) return false;
  await input.click({ delay: 50 }).catch(() => {});
  await page.keyboard.press('ControlOrMeta+A').catch(() => {});
  await page.keyboard.type(VERIFY_CODE, { delay: 20 }).catch(async () => {
    await page.keyboard.insertText(VERIFY_CODE).catch(() => {});
  });
  await page.waitForTimeout(1000).catch(() => {});
  console.log(JSON.stringify({ stage: 'filled_code', redacted: true }));
  return true;
}

async function selectPhoneAssociationAccount(page) {
  const target = await page.evaluate(() => {
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], [role="group"], label, div'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: textOf(el),
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          area: rect.width * rect.height,
        };
      })
      .filter((item) => /Wisent Wisent Facebook/i.test(item.text) && item.y > 500 && !item.disabled)
      .sort((a, b) => {
        if (a.role === 'group' && b.role !== 'group') return -1;
        if (b.role === 'group' && a.role !== 'group') return 1;
        return a.area - b.area;
      });
    return candidates[0] || null;
  }).catch(() => null);
  if (!target) return null;
  await page.mouse.click(target.x, target.y, { delay: 50 });
  await page.waitForTimeout(1000).catch(() => {});
  console.log(JSON.stringify({ stage: 'clicked', label: 'select_phone_association_account', text: sanitize(target.text), role: target.role, x: target.x, y: target.y }));
  return target;
}

console.log(JSON.stringify({
  stage: 'start',
  userDataDir: USER_DATA_DIR,
  headless: process.env.META_VERIFY_HEADLESS === '1',
}, null, 2));

const s = await WSession.start({
  label: 'meta_accounts_center_add_phone',
  browser: process.env.BROWSER || 'chromium',
  proxy: process.env.PROXY_URL || 'direct',
  persona: stableProfilePersona(),
  userDataDir: USER_DATA_DIR,
  headless: process.env.META_VERIFY_HEADLESS === '1',
  pageDiagnostics: process.env.WELES_PAGE_DIAGNOSTICS === '1',
});

let exitCode = 0;
try {
  await bringBrowserToFront(s);
  await s.page.goto('https://accountscenter.facebook.com/youraccount/contact_points/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  const initial = await snapshot(s.page, 'contact_points_initial');
  if (CODE_ONLY) {
    if (!VERIFY_CODE) throw new Error('META_VERIFY_CODE is required when META_VERIFY_CODE_ONLY=1');
    if (!initial.statusHints.code) {
      await clickFirst(s.page, 'open_pending_contact', /Oczekuje na potwierdzenie|Pending confirmation|pending/i);
    }
    let codeScreen = await snapshot(s.page, 'code_only_screen');
    if (!codeScreen.statusHints.code) {
      await clickFirst(s.page, 'confirm_pending_contact', /Potwierdź numer|Confirm number|Verify number/i);
      codeScreen = await snapshot(s.page, 'code_only_confirm_screen');
    }
    if (!codeScreen.statusHints.code && codeScreen.statusHints.phoneChoice) {
      await fillPhone(s.page);
      await selectPhoneAssociationAccount(s.page);
      await snapshot(s.page, 'code_only_phone_form_ready');
      const phoneSubmitted = await clickFirst(s.page, 'submit_code_only_phone_form', /^(Dalej|Next|Wyślij|Send|Kontynuuj|Continue)$/i);
      if (!phoneSubmitted) throw new Error('No enabled submit button found while reopening pending phone confirmation');
      codeScreen = await snapshot(s.page, 'code_only_after_phone_submit');
    }
    if (!codeScreen.statusHints.code) throw new Error('No confirmation code screen found for META_VERIFY_CODE_ONLY=1');
    if (!await fillCode(s.page)) throw new Error('No confirmation code input found');
    await snapshot(s.page, 'code_only_filled');
    const submitted = await clickFirst(s.page, 'submit_code_only', /^(Dalej|Next|Wyślij|Send|Kontynuuj|Continue)$/i);
    if (!submitted) throw new Error('No enabled code submit button found in META_VERIFY_CODE_ONLY=1');
    await snapshot(s.page, 'after_code_only_submit');
    await waitAndClickFirst(s.page, 'skip_passkey', /^(Nie teraz|Not now)$/i, /Utwórz|Create/i, 12);
    await snapshot(s.page, 'after_code_only_passkey_skip');
    await bringBrowserToFront(s);
  } else {
    const add = await clickFirst(s.page, 'add_new_contact', /Dodaj nowy kontakt|Add new contact/i);
    if (!add) throw new Error('No Add new contact control found');
    await snapshot(s.page, 'after_add_new_contact');
    await clickFirst(s.page, 'choose_phone', /Dodaj numer telefonu|Add.*phone|Mobile number|Numer telefonu/i);
    await snapshot(s.page, 'phone_form');
    if (!await fillPhone(s.page)) throw new Error('No phone input found');
    await snapshot(s.page, 'phone_filled');
    await selectPhoneAssociationAccount(s.page);
    await snapshot(s.page, 'after_select_account');
    const submitted = await clickFirst(s.page, 'submit_phone', /^(Dalej|Next|Wyślij|Send|Kontynuuj|Continue)$/i);
    if (!submitted) throw new Error('No enabled submit button found after filling phone');
    const afterSubmit = await snapshot(s.page, 'after_submit');
    if (afterSubmit.statusHints.code) {
      if (!VERIFY_CODE) {
        console.log('NEED_CODE: META_VERIFY_CODE is required to submit the confirmation code');
      } else if (await fillCode(s.page)) {
        await snapshot(s.page, 'code_filled');
        const codeSubmitted = await clickFirst(s.page, 'submit_code', /^(Dalej|Next|Wyślij|Send|Kontynuuj|Continue)$/i);
        if (!codeSubmitted) throw new Error('No enabled code submit button found after entering confirmation code');
        await snapshot(s.page, 'after_code_submit');
        await waitAndClickFirst(s.page, 'skip_passkey', /^(Nie teraz|Not now)$/i, /Utwórz|Create/i, 12);
        await snapshot(s.page, 'after_passkey_skip');
      } else {
        throw new Error('No confirmation code input found');
      }
    } else {
      await bringBrowserToFront(s);
    }
  }
} catch (error) {
  exitCode = 1;
  console.log(`FAIL: ${error.message || String(error)}`);
} finally {
  await s.close().catch(() => {});
}

if (exitCode) process.exit(exitCode);
