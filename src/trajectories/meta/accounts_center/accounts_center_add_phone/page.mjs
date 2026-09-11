// The Accounts Center page: the stable persona, sanitised URLs and snapshots.
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

export function sanitize(text) {
  return String(text || '')
    .replace(/\+\d[\d\s().-]{6,}\d/g, '<phone-redacted>')
    .replace(/\b\d{7,}\b/g, '<number-redacted>');
}

export function sanitizedUrl(rawUrl) {
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
