// Focused Meta Business Settings probe for system users and token generation.
//
// This uses a Weles browser profile that is already logged in to Meta. It only
// prints sanitized UI state unless a token is successfully generated, in which
// case the token is stored in Content Platform without printing the secret.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { generatePersona } from '../../../dist/browser/persona.js';
import { WSession } from '../../../dist/session/wsession.js';

const META_BASE_URL = 'https://graph.facebook.com/v21.0';
const DEFAULT_CONTENT_PLATFORM_DIR = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/content-platform';
const CONTENT_PLATFORM_DIR = process.env.CONTENT_PLATFORM_DIR || DEFAULT_CONTENT_PLATFORM_DIR;
const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'meta_ads');
const BUSINESS_ID = process.env.META_BUSINESS_ID || process.env.BUSINESS_ID || '885982240795843';
const APP_ID = process.env.META_APP_ID || process.env.NEXT_PUBLIC_META_ADS_APP_ID || '931029642750405';
const WAIT_MS = Number(process.env.WAIT_MS || 5000);
const PERMISSIONS = (process.env.META_SYSTEM_USER_SCOPES || 'ads_read,ads_management,business_management')
  .split(',')
  .map((scope) => scope.trim())
  .filter(Boolean);
mkdirSync(USER_DATA_DIR, { recursive: true });
process.env.WELES_VIEWPORT ??= '1440x1000';

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals < 0) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value.replace(/\\n$/, '');
  }
  return env;
}

function loadContentPlatformEnv() {
  return {
    ...process.env,
    ...loadEnvFile(resolve(CONTENT_PLATFORM_DIR, '.env.production')),
    ...loadEnvFile(resolve(CONTENT_PLATFORM_DIR, '.env.local')),
  };
}

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

function sanitizeTokenish(text) {
  return text
    .replace(/\bEA[A-Za-z0-9_-]{80,}\b/g, '<meta-token-redacted>')
    .replace(/\b[A-Za-z0-9_-]{120,}\b/g, '<long-secret-redacted>');
}

function extractMetaToken(text) {
  const matches = text.match(/\bEA[A-Za-z0-9_-]{80,}\b/g) || [];
  return matches[0] || '';
}

async function supabaseFetch(env, path, init = {}) {
  const url = `${env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, '')}/rest/v1${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.message || data?.error || text || `Supabase ${res.status}`);
  return data;
}

async function metaGet(path, params) {
  const res = await fetch(`${META_BASE_URL}${path}?${params}`);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message || JSON.stringify(data));
  return data;
}

async function fetchAdAccounts(token) {
  const params = new URLSearchParams({
    fields: 'name,currency,account_status,account_id',
    access_token: token,
  });
  const data = await metaGet('/me/adaccounts', params);
  return data.data || [];
}

async function storeTokenInContentPlatform(token) {
  const env = loadContentPlatformEnv();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('missing Content Platform Supabase env');
  }

  const existingAccounts = await supabaseFetch(
    env,
    '/ad_accounts?platform=eq.meta&select=id,user_id,platform,account_id,account_name,currency,is_active,metadata&order=created_at.desc',
  );
  const primary = existingAccounts.find((account) => account.is_active) || existingAccounts[0];
  if (!primary) throw new Error('no Meta ad account row exists to infer user_id');

  const accounts = await fetchAdAccounts(token);
  if (!accounts.length) throw new Error('generated token is valid, but no Meta ad accounts are accessible');

  const existingByAccountId = new Map(existingAccounts.map((account) => [account.account_id, account]));
  const upserted = [];
  for (const account of accounts) {
    const prior = existingByAccountId.get(account.account_id) || primary;
    const body = [{
      user_id: primary.user_id,
      platform: 'meta',
      account_id: account.account_id,
      account_name: account.name || prior.account_name || 'Meta Ads',
      access_token: token,
      refresh_token: null,
      currency: account.currency || prior.currency || 'USD',
      is_active: true,
      metadata: {
        ...(prior.metadata || {}),
        app_id: APP_ID,
        business_id: BUSINESS_ID,
        platform_id: account.id,
        account_status: String(account.account_status),
      },
      updated_at: new Date().toISOString(),
    }];
    const rows = await supabaseFetch(
      env,
      '/ad_accounts?on_conflict=user_id,platform,account_id&select=id,account_id,account_name,currency,metadata',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=representation',
        },
        body: JSON.stringify(body),
      },
    );
    upserted.push(...rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      accountName: row.account_name,
      currency: row.currency,
      metadataKeys: Object.keys(row.metadata || {}).sort(),
    })));
  }
  return upserted;
}

async function pageSnapshot(page, label) {
  await page.waitForTimeout(WAIT_MS).catch(() => {});
  const data = await page.evaluate(() => {
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const controlSelector = 'button, [role="button"], a, input[type="button"], input[type="submit"], [role="menuitem"], [aria-label]';
    const controls = Array.from(document.querySelectorAll(controlSelector))
      .filter(visible)
      .map((el) => ({
        text: textOf(el).slice(0, 160),
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        href: el.getAttribute('href') || '',
        disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      }))
      .filter((item) => item.text || item.href)
      .slice(0, 90);
    const bodyText = textOf(document.body);
    return {
      title: document.title || null,
      bodyText: bodyText.slice(0, 2200),
      tokenPresent: /\bEA[A-Za-z0-9_-]{80,}\b/.test(bodyText),
      controls,
      statusHints: {
        login: /log in|login|password|email|zaloguj|hasło/i.test(bodyText),
        systemUsers: /system users|systemowi|użytkownicy systemowi|system user/i.test(bodyText),
        noSystemUsers: /no system users|brak użytkowników systemowych|nie masz użytkowników systemowych/i.test(bodyText),
        generate: /generate|wygeneruj|generuj|token/i.test(bodyText),
        permissionDenied: /permission|uprawn|access denied|brak dostępu|not authorized|nie masz dostępu/i.test(bodyText),
      },
    };
  });
  const sanitized = {
    ...data,
    bodyText: sanitizeTokenish(data.bodyText),
    controls: data.controls.map((control) => ({
      ...control,
      text: sanitizeTokenish(control.text),
      href: sanitizedUrl(control.href),
    })),
  };
  console.log(JSON.stringify({
    stage: 'snapshot',
    label,
    url: sanitizedUrl(page.url?.() || ''),
    ...sanitized,
  }, null, 2));
  return data;
}

async function clickFirst(page, label, allow, deny = /delete|remove|usuń|anuluj|cancel|dezaktywuj/i) {
  const target = await page.evaluate(({ allowSource, allowFlags, denySource, denyFlags }) => {
    const allowRe = new RegExp(allowSource, allowFlags);
    const denyRe = new RegExp(denySource, denyFlags);
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, [role="menuitem"], input[type="button"], input[type="submit"], [aria-label]'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = textOf(el);
        return {
          text,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          area: rect.width * rect.height,
        };
      })
      .filter((item) => item.text && !item.disabled && allowRe.test(item.text) && !denyRe.test(item.text))
      .sort((a, b) => b.area - a.area);
    return candidates[0] || null;
  }, {
    allowSource: allow.source,
    allowFlags: allow.flags,
    denySource: deny.source,
    denyFlags: deny.flags,
  }).catch(() => null);
  if (!target) return null;
  await page.mouse.click(target.x, target.y, { delay: 50 });
  await page.waitForTimeout(1500).catch(() => {});
  console.log(JSON.stringify({
    stage: 'clicked',
    label,
    text: sanitizeTokenish(target.text).slice(0, 180),
    x: target.x,
    y: target.y,
  }));
  return target;
}

async function clickByTextContent(page, label, text) {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return clickFirst(page, label, new RegExp(escaped, 'i'));
}

async function fillVisibleInput(page, label, value, selector = 'input[type="text"], input:not([type]), textarea') {
  const filled = await page.evaluate(({ selector, value }) => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const el = Array.from(document.querySelectorAll(selector)).find(visible);
    if (!el) return false;
    el.focus();
    if ('value' in el) {
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  }, { selector, value }).catch(() => false);
  if (filled) {
    console.log(JSON.stringify({ stage: 'filled', label }));
    await page.waitForTimeout(1000).catch(() => {});
  }
  return filled;
}

async function clickPermission(page, scope) {
  const clicked = await page.evaluate((scope) => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const exact = new RegExp(`(^|\\s)${scope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'i');
    const label = Array.from(document.querySelectorAll('label, [role="checkbox"], [role="switch"], div, span'))
      .filter(visible)
      .find((el) => exact.test(textOf(el)));
    if (!label) return false;
    const container = label.closest('[role="checkbox"], [role="switch"], label, [aria-checked], div') || label;
    const checked = container.getAttribute('aria-checked') === 'true' || container.querySelector('input[type="checkbox"]')?.checked === true;
    if (!checked) {
      const rect = container.getBoundingClientRect();
      const x = Math.round(rect.left + Math.min(24, rect.width / 2));
      const y = Math.round(rect.top + rect.height / 2);
      const target = document.elementFromPoint(x, y) || container;
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
    }
    return true;
  }, scope).catch(() => false);
  if (clicked) {
    console.log(JSON.stringify({ stage: 'permission_selected', scope }));
    await page.waitForTimeout(500).catch(() => {});
  }
  return clicked;
}

async function extractTokenFromPage(page) {
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  return extractMetaToken(text);
}

async function driveTokenFlow(page) {
  const first = await pageSnapshot(page, 'system_users_initial');
  if (first.statusHints.login) return { status: 'login_required' };
  if (first.statusHints.permissionDenied) return { status: 'permission_denied' };

  let token = await extractTokenFromPage(page);
  if (token) return { status: 'token_found', token };

  let clicked = await clickFirst(
    page,
    'generate_token',
    /generate new token|generate token|wygeneruj nowy token|wygeneruj token|generuj token|utwórz token/i,
  );
  if (!clicked) {
    clicked = await clickFirst(page, 'select_system_user_or_more', /system user|użytkownik systemowy|wisent|content platform|więcej|more|actions|działania/i);
    if (clicked) {
      await pageSnapshot(page, 'after_select_system_user');
      clicked = await clickFirst(
        page,
        'generate_token_after_select',
        /generate new token|generate token|wygeneruj nowy token|wygeneruj token|generuj token|utwórz token/i,
      );
    }
  }

  if (!clicked && first.statusHints.noSystemUsers) {
    clicked = await clickFirst(page, 'add_system_user', /^add$|^dodaj$|create system user|utwórz użytkownika systemowego/i);
    if (clicked) {
      await fillVisibleInput(page, 'system_user_name', 'Content Platform Meta Ads');
      await clickFirst(page, 'system_user_role_admin', /admin|administrator/i);
      await clickFirst(page, 'create_system_user', /^create$|^utwórz$|^done$|^gotowe$|^next$|^dalej$/i);
      await pageSnapshot(page, 'after_create_system_user');
      clicked = await clickFirst(
        page,
        'generate_token_after_create',
        /generate new token|generate token|wygeneruj nowy token|wygeneruj token|generuj token|utwórz token/i,
      );
    }
  }

  if (!clicked) return { status: 'no_generate_control' };

  await pageSnapshot(page, 'token_modal_open');

  await clickByTextContent(page, 'select_app_id', APP_ID);
  await clickFirst(page, 'open_app_dropdown', /select app|wybierz aplikację|app|aplikacja/i);
  await clickByTextContent(page, 'select_app_after_dropdown', APP_ID);
  await clickFirst(page, 'select_app_by_name', /wisent/i);

  for (const scope of PERMISSIONS) {
    await clickPermission(page, scope);
  }

  await pageSnapshot(page, 'before_generate_click');
  await clickFirst(
    page,
    'confirm_generate',
    /^generate token$|^generate$|^wygeneruj token$|^wygeneruj$|^generuj token$|^utwórz token$|^done$|^gotowe$/i,
  );
  await page.waitForTimeout(WAIT_MS).catch(() => {});
  await pageSnapshot(page, 'after_generate_click');

  token = await extractTokenFromPage(page);
  if (token) return { status: 'generated', token };
  return { status: 'token_not_visible_after_generate' };
}

console.log(JSON.stringify({
  stage: 'start',
  userDataDir: USER_DATA_DIR,
  businessId: BUSINESS_ID,
  appId: APP_ID,
  scopes: PERMISSIONS,
  headless: process.env.META_BUSINESS_HEADLESS !== '0',
}, null, 2));

const s = await WSession.start({
  label: 'meta_system_users_token_probe',
  browser: process.env.BROWSER || 'chromium',
  proxy: process.env.PROXY_URL || 'direct',
  persona: stableProfilePersona(),
  userDataDir: USER_DATA_DIR,
  headless: process.env.META_BUSINESS_HEADLESS !== '0',
  pageDiagnostics: process.env.WELES_PAGE_DIAGNOSTICS === '1',
});

let exitCode = 0;
try {
  const url = `https://business.facebook.com/latest/settings/system_users?business_id=${encodeURIComponent(BUSINESS_ID)}`;
  await s.page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const result = await driveTokenFlow(s.page);
  if (result.token) {
    const rows = await storeTokenInContentPlatform(result.token);
    console.log(JSON.stringify({
      stage: 'connected',
      status: result.status,
      connectedAccountCount: rows.length,
      accounts: rows,
    }, null, 2));
    console.log('PASS: Meta system-user token connected to Content Platform');
  } else {
    exitCode = 1;
    console.log(JSON.stringify({ stage: 'not_connected', status: result.status }, null, 2));
    console.log(`FAIL: Meta system-user token was not generated; status=${result.status}`);
  }
} catch (error) {
  exitCode = 1;
  console.log(`FAIL: ${error.message || String(error)}`);
} finally {
  await s.close().catch(() => {});
}

if (exitCode) process.exit(exitCode);
