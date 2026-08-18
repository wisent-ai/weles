// Search Meta owner/approval surfaces and complete any exposed safe approval steps.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generatePersona } from '../../../dist/browser/persona.js';
import { WSession } from '../../../dist/session/wsession.js';

const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'meta_ads');
const BUSINESS_ID = process.env.META_BUSINESS_ID || process.env.BUSINESS_ID || '885982240795843';
const AD_ACCOUNT_ID = (process.env.AD_ACCOUNT_ID || process.env.META_AD_ACCOUNT_ID || '849988068092449').replace(/^act_/, '');
const APP_ID = process.env.META_APP_ID || '931029642750405';
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
  const data = await page.evaluate(({ adAccountId, appId }) => {
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const bodyText = textOf(document.body);
    const controls = Array.from(document.querySelectorAll('button, [role="button"], a, [role="menuitem"], input[type="button"], input[type="submit"]'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: textOf(el).slice(0, 180),
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          href: el.getAttribute('href') || '',
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      })
      .filter((item) => item.text || item.href)
      .slice(0, 140);
    return {
      title: document.title || null,
      bodyText: bodyText.slice(0, 4200),
      controls,
      statusHints: {
        login: /log in|login|password|email|zaloguj|hasło/i.test(bodyText),
        needsReviewEmpty: /no requests need review|there are no requests for you to review|brak próśb do sprawdzenia/i.test(bodyText),
        sentRequest: /prośba została wysłana|request sent|request has been sent|oczekuje na rozpatrzenie|pending approval/i.test(bodyText),
        adAccountPresent: bodyText.includes(adAccountId),
        appPresent: bodyText.includes(appId),
        inactiveApp: /aplikacja nieaktywna|app inactive|this app is currently unavailable|ta aplikacja nie jest teraz dostępna/i.test(bodyText),
        approveControl: controls.some((item) => /^(approve|accept|confirm|grant access|zatwierdź|zaakceptuj|potwierdź|udziel dostępu)$/i.test(item.text) && !item.disabled),
        activateControl: controls.some((item) => /activate|reactivate|switch to live|go live|aktywuj|włącz/i.test(item.text) && !item.disabled),
      },
    };
  }, { adAccountId: AD_ACCOUNT_ID, appId: APP_ID });
  console.log(JSON.stringify({
    stage: 'snapshot',
    label,
    url: sanitizedUrl(page.url?.() || ''),
    ...data,
  }, null, 2));
  return data;
}

async function clickFirst(page, label, allow, deny = /cancel|anuluj|delete|remove|usuń|leave|opuść|transfer|przenieś|cancel request|anuluj prośbę/i) {
  const target = await page.evaluate(({ allowSource, allowFlags, denySource, denyFlags }) => {
    const allowRe = new RegExp(allowSource, allowFlags);
    const denyRe = new RegExp(denySource, denyFlags);
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, [role="menuitem"], input[type="button"], input[type="submit"]'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = textOf(el);
        let score = 0;
        if (el.matches('button, [role="button"], input[type="button"], input[type="submit"]')) score += 1000;
        if (rect.left > 300) score += 100;
        if (rect.top > 80) score += 50;
        score -= Math.min(rect.width * rect.height, 100000) / 10000;
        return {
          text,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          score,
        };
      })
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
  await page.waitForTimeout(WAIT_MS).catch(() => {});
  console.log(JSON.stringify({ stage: 'clicked', label, text: target.text.slice(0, 180), x: target.x, y: target.y }));
  return target;
}

async function tryApproveOrActivate(page, label) {
  const approve = await clickFirst(page, `${label}:approve`, /^(approve|accept|grant access|zatwierdź|zaakceptuj|udziel dostępu)$/i);
  if (approve) {
    await clickFirst(page, `${label}:approve_confirm`, /^(confirm|potwierdź|approve|accept|zatwierdź|zaakceptuj)$/i);
    return 'approval_clicked';
  }
  const activate = await clickFirst(page, `${label}:activate`, /activate|reactivate|switch to live|go live|aktywuj|włącz/i);
  if (activate) {
    await clickFirst(page, `${label}:activate_confirm`, /^(confirm|potwierdź|activate|aktywuj|włącz)$/i);
    return 'activate_clicked';
  }
  return null;
}

const candidateUrls = [
  ['business_requests', `https://business.facebook.com/latest/settings/requests?business_id=${encodeURIComponent(BUSINESS_ID)}`],
  ['business_requests_unscoped', 'https://business.facebook.com/latest/settings/requests'],
  ['legacy_business_requests', `https://business.facebook.com/settings/requests?business_id=${encodeURIComponent(BUSINESS_ID)}`],
  ['business_ad_account_pending', `https://business.facebook.com/latest/settings/ad_accounts/?business_id=${encodeURIComponent(BUSINESS_ID)}&selected_asset_type=ad-account`],
  ['ads_account_settings_act', `https://business.facebook.com/ads/manager/account_settings/?act=${encodeURIComponent(AD_ACCOUNT_ID)}`],
  ['ads_manager_act', `https://business.facebook.com/adsmanager/manage/campaigns?act=${encodeURIComponent(AD_ACCOUNT_ID)}`],
  ['developer_app', `https://developers.facebook.com/apps/${encodeURIComponent(APP_ID)}/dashboard/`],
  ['developer_apps', 'https://developers.facebook.com/apps/'],
];

console.log(JSON.stringify({
  stage: 'start',
  userDataDir: USER_DATA_DIR,
  businessId: BUSINESS_ID,
  adAccountId: AD_ACCOUNT_ID,
  appId: APP_ID,
  headless: process.env.META_BUSINESS_HEADLESS !== '0',
}, null, 2));

const s = await WSession.start({
  label: 'meta_business_approval_autopilot',
  browser: process.env.BROWSER || 'chromium',
  proxy: process.env.PROXY_URL || 'direct',
  persona: stableProfilePersona(),
  userDataDir: USER_DATA_DIR,
  headless: process.env.META_BUSINESS_HEADLESS !== '0',
  pageDiagnostics: process.env.WELES_PAGE_DIAGNOSTICS === '1',
});

let exitCode = 0;
const actions = [];
try {
  for (const [label, url] of candidateUrls) {
    await s.page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const first = await snapshot(s.page, label);
    const action = await tryApproveOrActivate(s.page, label);
    if (action) {
      actions.push({ label, action });
      await snapshot(s.page, `${label}:after_action`);
    }
    if (/requests/i.test(label)) {
      for (const tab of [
        ['needs_review', /needs review|do sprawdzenia|wymaga sprawdzenia/i],
        ['sent', /^sent$|wysłane|wysłano/i],
        ['completed', /completed|zakończone/i],
      ]) {
        const clicked = await clickFirst(s.page, `${label}:${tab[0]}`, tab[1], /cancel|anuluj/i);
        if (clicked) {
          const tabSnap = await snapshot(s.page, `${label}:${tab[0]}`);
          const tabAction = await tryApproveOrActivate(s.page, `${label}:${tab[0]}`);
          if (tabAction) {
            actions.push({ label: `${label}:${tab[0]}`, action: tabAction });
            await snapshot(s.page, `${label}:${tab[0]}:after_action`);
          }
          if (tabSnap.statusHints.adAccountPresent) {
            await clickFirst(s.page, `${label}:${tab[0]}:open_request`, new RegExp(AD_ACCOUNT_ID));
            await snapshot(s.page, `${label}:${tab[0]}:request_opened`);
          }
        }
      }
    }
    if (first.statusHints.login) {
      console.log(JSON.stringify({ stage: 'login_surface', label }));
    }
  }
  console.log(JSON.stringify({ stage: 'actions', actions }, null, 2));
  if (!actions.length) {
    console.log('PASS: approval autopilot found no exposed approval or activation controls in the current Weles Meta session');
  } else {
    console.log('PASS: approval autopilot executed exposed Meta controls');
  }
} catch (error) {
  exitCode = 1;
  console.log(`FAIL: ${error.message || String(error)}`);
} finally {
  await s.close().catch(() => {});
}

if (exitCode) process.exit(exitCode);
