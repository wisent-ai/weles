// The Accounts Center page (persona, sanitised URLs, snapshots) and the phone number shapes.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generatePersona } from '../../../../../dist/browser/persona.js';
import { USER_DATA_DIR, WAIT_MS } from './settings.mjs';

export function stableProfilePersona() {
  const p = join(USER_DATA_DIR, 'persona.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const persona = generatePersona({ os: 'macos', browser: 'chromium' });
  writeFileSync(p, JSON.stringify(persona, null, 2));
  return persona;
}

export function sanitizedUrl(rawUrl) {
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

export async function bringBrowserToFront(s) {
  await s.page.bringToFront().catch(() => {});
  if (process.platform !== 'darwin') return;
  spawnSync('osascript', ['-e', 'tell application "Chromium" to activate'], { stdio: 'ignore' });
  spawnSync('osascript', ['-e', 'tell application "System Events" to set frontmost of every process whose name is "Chromium" to true'], { stdio: 'ignore' });
}

export async function snapshot(page, label) {
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

export function normalizePhone(raw) {
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

export function phoneCountry(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('48')) return '+48';
  if (digits.startsWith('1')) return '+1';
  return 'unknown';
}

export function phoneNationalNumber(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('48')) return digits.slice(2);
  if (digits.startsWith('1')) return digits.slice(1);
  return digits;
}
