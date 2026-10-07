// Connect the configured Meta app ID to the current Business portfolio via UI.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generatePersona } from '../../../../dist/browser/persona.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanType } from '../../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { pageSettled } from '../../_shared/page/settled.mjs';
import { statedText } from '../../_shared/inputs/stated.mjs';

const USER_DATA_DIR =
  process.env.WELES_USER_DATA_DIR ||
  process.env.ADS_PROFILE_DIR ||
  join(homedir(), '.weles', 'browser_profiles', 'meta_ads');
const BUSINESS_ID = statedText(
  ['META_BUSINESS_ID', 'BUSINESS_ID'],
  'the Meta Business Manager id this run acts in',
);
const APP_ID = statedText(
  ['META_APP_ID', 'NEXT_PUBLIC_META_ADS_APP_ID'],
  'the Meta app id this run acts on',
);
mkdirSync(USER_DATA_DIR, { recursive: true });

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
      if (/token|code|secret|state|session|auth/i.test(key))
        parsed.searchParams.set(key, '<redacted>');
    }
    return parsed.toString();
  } catch {
    return '<invalid-url>';
  }
}

async function snapshot(page, label) {
  await pageSettled(page);
  const data = await page.evaluate((appId) => {
    const textOf = (el) =>
      (el.innerText || el.textContent || el.getAttribute('aria-label') || '')
        .replace(/\s+/g, ' ')
        .trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const controls = Array.from(
      document.querySelectorAll(
        'button, [role="button"], a, [role="menuitem"], input, textarea, [aria-label]',
      ),
    )
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = textOf(el) || el.getAttribute('placeholder') || '';
        return {
          text: text,
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          placeholder: el.getAttribute('placeholder') || '',
          disabled:
            el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      })
      .filter((item) => item.text || item.placeholder);
    const bodyText = textOf(document.body);
    return {
      title: document.title || null,
      bodyText: bodyText,
      controls,
      statusHints: {
        permissionDenied:
          /brak dostępu|permission|uprawn|not authorized|nie możesz|nie masz/i.test(
            bodyText,
          ),
        technicalError:
          /niespodziewany problem techniczny|unexpected technical problem|try again|spróbuj ponownie/i.test(
            bodyText,
          ),
        alreadyConnected: /już.*dod|already|połączono|connected/i.test(
          bodyText,
        ),
        appPresent: bodyText.includes(appId),
      },
    };
  }, APP_ID);
  console.log(
    JSON.stringify(
      {
        stage: 'snapshot',
        label,
        url: sanitizedUrl(page.url?.() || ''),
        ...data,
      },
      null,
      2,
    ),
  );
  return data;
}

async function clickFirst(
  page,
  label,
  allow,
  deny = /delete|remove|usuń|anuluj|cancel|zamknij/i,
) {
  const target = await page
    .evaluate(
      ({ allowSource, allowFlags, denySource, denyFlags }) => {
        const allowRe = new RegExp(allowSource, allowFlags);
        const denyRe = new RegExp(denySource, denyFlags);
        const textOf = (el) =>
          (
            el.innerText ||
            el.textContent ||
            el.getAttribute('aria-label') ||
            ''
          )
            .replace(/\s+/g, ' ')
            .trim();
        const visible = (el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return (
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            rect.width > 0 &&
            rect.height > 0
          );
        };
        const nodes = Array.from(
          document.querySelectorAll(
            'button, [role="button"], a, [role="menuitem"], div, span',
          ),
        )
          .filter(visible)
          .map((el) => {
            const rect = el.getBoundingClientRect();
            const text = textOf(el);
            const area = rect.width * rect.height;
            let score = Math.max(0, 500000 - area);
            if (el.matches('button, [role="button"], a, [role="menuitem"]'))
              score += 100000;
            if (rect.left > 300) score += 10000;
            return {
              text,
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
              disabled:
                el.disabled === true ||
                el.getAttribute('aria-disabled') === 'true',
              area,
              score,
            };
          })
          .filter((item) => item.area < 500000)
          .filter(
            (item) =>
              item.text &&
              !item.disabled &&
              allowRe.test(item.text) &&
              !denyRe.test(item.text),
          )
          .sort((a, b) => b.score - a.score);
        return nodes[0] || null;
      },
      {
        allowSource: allow.source,
        allowFlags: allow.flags,
        denySource: deny.source,
        denyFlags: deny.flags,
      },
    )
    .catch(() => null);
  if (!target) return null;
  await page.mouse.click(target.x, target.y);
  await pageSettled(page);
  console.log(
    JSON.stringify({
      stage: 'clicked',
      label,
      text: target.text,
      x: target.x,
      y: target.y,
    }),
  );
  return target;
}

// The id goes into the open dialog's text field, found on the page, so no
// screen position is assumed.
async function fillAppId(page) {
  const field = page
    .locator(
      '[role="dialog"] input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])',
    )
    .filter({ visible: true })
    .first();
  await field.waitFor({ state: 'visible' });
  await humanClickLocator(page, field);
  await page.keyboard.press('ControlOrMeta+A').catch(() => {});
  await humanType(page, APP_ID);
  console.log(JSON.stringify({ stage: 'filled_app_id', appId: APP_ID }));
  await pageSettled(page);
  return true;
}

console.log(
  JSON.stringify(
    {
      stage: 'start',
      userDataDir: USER_DATA_DIR,
      businessId: BUSINESS_ID,
      appId: APP_ID,
      headless: process.env.META_BUSINESS_HEADLESS !== '0',
    },
    null,
    2,
  ),
);

const s = await WSession.start({
  label: 'meta_business_connect_app',
  browser: process.env.BROWSER || 'chromium',
  proxy: process.env.PROXY_URL || 'direct',
  persona: stableProfilePersona(),
  userDataDir: USER_DATA_DIR,
  headless: process.env.META_BUSINESS_HEADLESS !== '0',
  pageDiagnostics: process.env.WELES_PAGE_DIAGNOSTICS === '1',
});

let exitCode = 0;
try {
  const url = `https://business.facebook.com/latest/settings/apps?business_id=${encodeURIComponent(BUSINESS_ID)}`;
  await s.page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await snapshot(s.page, 'initial_apps');
  await clickFirst(s.page, 'add', /^add$|^dodaj$/i);
  await snapshot(s.page, 'add_menu');
  const choseConnect = await clickFirst(
    s.page,
    'connect_app_id',
    /połącz identyfikator aplikacji|connect app id|add an app|dodaj aplikacj/i,
  );
  if (!choseConnect)
    throw new Error('Meta did not expose a Connect App ID option');
  await snapshot(s.page, 'connect_app_form');
  if (!(await fillAppId(s.page)))
    throw new Error('Meta did not expose an app ID input');
  await snapshot(s.page, 'app_id_filled');
  const submitted = await clickFirst(
    s.page,
    'submit_app_id',
    /^dodaj aplikację$|^add app$|poproś o aplikację|request app|^dalej$|^next$|^połącz$|^connect$/i,
  );
  if (!submitted)
    throw new Error('Meta did not expose an enabled app connect submit button');
  const result = await snapshot(s.page, 'after_submit');
  if (result.statusHints.technicalError) {
    throw new Error(
      `Meta returned a technical error while connecting app ${APP_ID}: ${result.bodyText}`,
    );
  }
  if (result.statusHints.permissionDenied) {
    throw new Error(
      `Meta refused app connection for app ${APP_ID}: ${result.bodyText}`,
    );
  }
  console.log('PASS: Meta app connection flow submitted');
} catch (error) {
  exitCode = 1;
  console.log(`FAIL: ${error.message || String(error)}`);
} finally {
  await s.close().catch(() => {});
}

if (exitCode) process.exit(exitCode);
