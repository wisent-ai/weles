// Meta Ads OAuth connector for Echo.
//
// Uses a Weles browser session to obtain a Meta user access token via OAuth,
// validates it against /me/adaccounts, then stores it in Echo's Supabase
// ad_accounts rows. Output is sanitized: no token or secret values.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generatePersona } from '../../../dist/browser/persona.js';
import { WSession } from '../../../dist/session/wsession.js';

const META_BASE_URL = 'https://graph.facebook.com/v21.0';
const DEFAULT_ECHO_DIR = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/echo';
const ECHO_DIR = process.env.ECHO_DIR || DEFAULT_ECHO_DIR;
const SOURCE_USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'meta_ads');
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://www.facebook.com/connect/login_success.html';
const WAIT_MS = Number(process.env.LOGIN_WAIT_MS || 600000);
const DATE = process.env.DATE || yesterdayLocal();
mkdirSync(SOURCE_USER_DATA_DIR, { recursive: true });
process.env.WELES_VIEWPORT ??= '1280x900';

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

function loadEchoEnv() {
  return {
    ...process.env,
    ...loadEnvFile(resolve(ECHO_DIR, '.env.production')),
    ...loadEnvFile(resolve(ECHO_DIR, '.env.local')),
  };
}

function configuredMetaToken(env) {
  const tokenFile = env.META_ADS_ACCESS_TOKEN_FILE || env.META_ACCESS_TOKEN_FILE;
  if (tokenFile && existsSync(tokenFile)) {
    return readFileSync(tokenFile, 'utf8').trim();
  }
  return env.META_ADS_ACCESS_TOKEN || env.META_ADS_SYSTEM_USER_TOKEN || env.META_ACCESS_TOKEN || '';
}

function configuredMetaPassword(env) {
  const passwordFile = env.META_ADS_LOGIN_PASSWORD_FILE || env.META_FACEBOOK_PASSWORD_FILE || env.FACEBOOK_PASSWORD_FILE;
  if (passwordFile && existsSync(passwordFile)) {
    return readFileSync(passwordFile, 'utf8').trim();
  }
  return env.META_ADS_LOGIN_PASSWORD || env.META_FACEBOOK_PASSWORD || env.FACEBOOK_PASSWORD || env.FB_PASSWORD || '';
}

function stableProfilePersona() {
  const p = join(SOURCE_USER_DATA_DIR, 'persona.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const persona = generatePersona({ os: 'macos', browser: 'chromium' });
  writeFileSync(p, JSON.stringify(persona, null, 2));
  return persona;
}

function yesterdayLocal() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function tokenFromUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const hash = new URLSearchParams(parsed.hash.replace(/^#/, ''));
  return hash.get('access_token') || parsed.searchParams.get('access_token');
}

function profileCopyFilter(src) {
  const base = src.split('/').pop() || '';
  if (/^Singleton/.test(base)) return false;
  if ([
    'Crashpad',
    'Crash Reports',
    'Cache',
    'Code Cache',
    'GPUCache',
    'ShaderCache',
    'GrShaderCache',
    'GraphiteDawnCache',
    'DawnGraphiteCache',
    'DawnWebGPUCache',
    'Safe Browsing',
    'optimization_guide_model_store',
    'component_crx_cache',
    'extensions_crx_cache',
  ].includes(base)) return false;
  return true;
}

function prepareUserDataDir() {
  if (process.env.META_OAUTH_USE_PROFILE_CLONE === '0') {
    return { dir: SOURCE_USER_DATA_DIR, cleanup: () => {} };
  }
  const cloneParent = mkdtempSync(join(tmpdir(), 'weles-meta-oauth-profile-'));
  const cloneDir = join(cloneParent, 'profile');
  cpSync(SOURCE_USER_DATA_DIR, cloneDir, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: profileCopyFilter,
  });
  return {
    dir: cloneDir,
    cleanup: () => rmSync(cloneParent, { recursive: true, force: true }),
  };
}

function oauthErrorFromUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const hash = new URLSearchParams(parsed.hash.replace(/^#/, ''));
  const error = hash.get('error') || parsed.searchParams.get('error');
  const message = hash.get('error_message') || parsed.searchParams.get('error_message');
  if (!error && !message) return null;
  return [error, message].filter(Boolean).join(': ');
}

function inactiveAppMessage(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (/aplikacja nieaktywna|ta aplikacja nie jest teraz dostępna/i.test(clean)) {
    return 'Meta OAuth app is inactive: Meta shows "Aplikacja nieaktywna / Ta aplikacja nie jest teraz dostępna"';
  }
  if (/app inactive|this app is currently unavailable|this app isn'?t available/i.test(clean)) {
    return 'Meta OAuth app is inactive: Meta shows "App inactive / This app is currently unavailable"';
  }
  return null;
}

function sanitizedUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = parsed.hash ? '#<redacted>' : '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|code|secret|state/i.test(key)) parsed.searchParams.set(key, '<redacted>');
    }
    return parsed.toString();
  } catch {
    return '<invalid-url>';
  }
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

async function fetchReach(accountId, token) {
  const params = new URLSearchParams({
    fields: 'account_id,account_name,reach,impressions,clicks,spend,ctr,cpc,cpm',
    level: 'account',
    time_increment: '1',
    time_range: JSON.stringify({ since: DATE, until: DATE }),
    access_token: token,
  });
  const data = await metaGet(`/${accountId}/insights`, params);
  const row = data.data?.[0] || {};
  const num = (value) => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    date: DATE,
    reach: num(row.reach),
    impressions: num(row.impressions),
    clicks: num(row.clicks),
    spend: num(row.spend),
    ctr: num(row.ctr),
    cpc: num(row.cpc),
    cpm: num(row.cpm),
  };
}

async function clickOAuthControl(page) {
  const target = await page.evaluate(() => {
    function textOf(el) {
      if (el instanceof HTMLInputElement) return (el.value || el.getAttribute('aria-label') || '').trim();
      return (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    }
    function visible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    }
    function disabled(el) {
      return el.disabled === true || el.getAttribute('aria-disabled') === 'true';
    }
    function topmostAt(el, x, y) {
      const topmost = document.elementFromPoint(x, y);
      if (!topmost) return false;
      return el === topmost || el.contains(topmost) || topmost.contains(el);
    }
    const deny = /create new account|use another profile|cancel|deny|decline|remove|not now|learn more/i;
    const allow = /^(continue|allow|confirm|ok|done|submit)$|^continue as\b|^log in as\b|^continue with\b|allow access|grant access/i;
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]'))
      .filter((el) => visible(el) && !disabled(el))
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const text = textOf(el);
        let score = rect.width * rect.height;
        if (topmostAt(el, x, y)) score += 100000;
        if (/^continue as\b/i.test(text)) score += 50000;
        if (/^continue$/i.test(text)) score += 40000;
        if (/allow|grant/i.test(text)) score += 30000;
        return { text, x, y, score };
      })
      .filter(({ text }) => text && allow.test(text) && !deny.test(text))
      .sort((a, b) => b.score - a.score);
    const preferred = candidates[0];
    if (!preferred) return null;
    return {
      text: preferred.text,
      x: Math.round(preferred.x),
      y: Math.round(preferred.y),
    };
  }).catch(() => null);
  if (!target) return null;
  await page.mouse.click(target.x, target.y, { delay: 50 });
  await page.waitForTimeout(750).catch(() => {});
  return target;
}

async function oauthPageSnapshot(page) {
  return page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 800);
    const controls = Array.from(document.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]'))
      .map((el) => {
        if (el instanceof HTMLInputElement) return (el.value || el.getAttribute('aria-label') || '').trim();
        return (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      })
      .filter(Boolean)
      .slice(0, 20);
    return { text, controls };
  }).catch(() => ({ text: '', controls: [] }));
}

async function submitPasswordDialog(page, env) {
  const passwordInput = page.locator('input[type="password"], input[name="pass"]').first();
  const passwordVisible = await passwordInput.isVisible({ timeout: 250 }).catch(() => false);
  if (!passwordVisible) return false;

  const password = configuredMetaPassword(env);
  if (!password) {
    if (process.env.META_OAUTH_ALLOW_USER_LOGIN === '1') {
      if (process.env.META_OAUTH_HEADLESS !== '0') {
        throw new Error('Meta OAuth reached Facebook password re-authentication; user-login mode requires META_OAUTH_HEADLESS=0');
      }
      return 'waiting_for_user';
    }
    throw new Error('Meta OAuth reached Facebook password re-authentication, but no configured Meta password or token is present');
  }

  await passwordInput.fill(password);
  const loginButton = page.getByRole('button', { name: /^log in$/i }).first();
  if (await loginButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    await loginButton.click();
  } else {
    await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(1000).catch(() => {});
  return 'submitted';
}

async function getTokenWithWeles(appId, env) {
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: REDIRECT_URI,
    scope: 'ads_read,ads_management,business_management',
    response_type: 'token',
    auth_type: 'rerequest',
  });
  const url = `https://www.facebook.com/v21.0/dialog/oauth?${params}`;
  const preparedProfile = prepareUserDataDir();
  const s = await WSession.start({
    label: 'meta_ads_oauth_connect',
    browser: process.env.BROWSER || 'chromium',
    proxy: process.env.PROXY_URL || 'direct',
    persona: stableProfilePersona(),
    userDataDir: preparedProfile.dir,
    headless: process.env.META_OAUTH_HEADLESS !== '0',
    pageDiagnostics: process.env.WELES_PAGE_DIAGNOSTICS === '1',
  });

  try {
    const page = await s.ctx.newPage().catch(() => s.page);
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const deadline = Date.now() + WAIT_MS;
    let lastLog = 0;
    let lastClick = 0;
    let lastUserLoginLog = 0;
    let repeatedClickKey = '';
    let repeatedClickCount = 0;
    while (Date.now() < deadline) {
      const pages = [...new Set([page, ...s.ctx.pages()])];
      const currentPage = pages.find((p) => /facebook\.com|meta\.com/i.test(p.url?.() || '')) || page;
      const current = currentPage.url?.() || '';
      const token = tokenFromUrl(current);
      if (token) return token;
      const err = oauthErrorFromUrl(current);
      if (err) throw new Error(err);
      if (/facebook\.com\/reg\//i.test(current)) {
        await currentPage.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await currentPage.waitForTimeout(1000).catch(() => {});
        continue;
      }
      const submittedPassword = await submitPasswordDialog(currentPage, env);
      if (submittedPassword === 'waiting_for_user') {
        if (Date.now() - lastUserLoginLog > 15000) {
          lastUserLoginLog = Date.now();
          console.log(JSON.stringify({
            stage: 'oauth_user_login_required',
            url: sanitizedUrl(current),
            message: 'Complete the Facebook password/2FA prompt in the Weles browser window',
          }));
        }
        await currentPage.waitForTimeout(1000).catch(() => {});
        continue;
      }
      if (submittedPassword === 'submitted') {
        console.log(JSON.stringify({ stage: 'oauth_password_submitted' }));
        await currentPage.waitForTimeout(1500).catch(() => {});
        continue;
      }
      if (Date.now() - lastClick > 1200) {
        lastClick = Date.now();
        const clicked = await clickOAuthControl(currentPage);
        if (clicked) {
          const clickKey = `${sanitizedUrl(current)}|${clicked.text}|${clicked.x}|${clicked.y}`;
          if (clickKey === repeatedClickKey) {
            repeatedClickCount += 1;
          } else {
            repeatedClickKey = clickKey;
            repeatedClickCount = 1;
          }
          console.log(JSON.stringify({
            stage: 'oauth_click',
            label: clicked.text.slice(0, 120),
            x: clicked.x,
            y: clicked.y,
          }));
          if (repeatedClickCount >= 8) {
            const snapshot = await oauthPageSnapshot(currentPage);
            throw new Error(`Meta OAuth stayed on ${sanitizedUrl(current)} after repeated "${clicked.text}" clicks; visible controls: ${snapshot.controls.join(' | ')}`);
          }
        }
      }
      if (Date.now() - lastLog > 15000) {
        lastLog = Date.now();
        const title = await currentPage.title().catch(() => '');
        const snapshot = await oauthPageSnapshot(currentPage);
        const inactive = inactiveAppMessage(snapshot.text);
        if (inactive) {
          throw new Error(`${inactive}; url=${sanitizedUrl(current)}; text="${snapshot.text.slice(0, 260)}"`);
        }
        console.log(JSON.stringify({
          stage: 'oauth_wait',
          url: sanitizedUrl(current),
          title,
          inactiveApp: false,
          hasLoginText: /log in|login|password|email/i.test(snapshot.text),
          hasConsentText: /continue|permission|allow|ads|business/i.test(snapshot.text),
          controls: snapshot.controls,
        }));
      }
      await currentPage.waitForTimeout(1000).catch(() => {});
    }
    throw new Error('Meta OAuth did not return an access token');
  } finally {
    await s.close().catch(() => {});
    preparedProfile.cleanup();
  }
}

const env = loadEchoEnv();
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log('FAIL: missing Echo Supabase env');
  process.exit(1);
}

const existingAccounts = await supabaseFetch(
  env,
  '/ad_accounts?platform=eq.meta&is_active=eq.true&select=id,user_id,platform,account_id,account_name,currency,is_active,metadata,access_token&order=created_at.desc',
);
const primary = existingAccounts[0];
if (!primary) {
  console.log('FAIL: no active Meta ad account row exists');
  process.exit(1);
}
const appId = process.env.META_APP_ID || primary.metadata?.app_id;
if (!appId) {
  console.log('FAIL: active Meta ad account row does not have metadata.app_id');
  process.exit(1);
}

console.log(JSON.stringify({
  stage: 'oauth_start',
  echoDir: ECHO_DIR,
  appIdPresent: true,
  redirectUri: REDIRECT_URI,
  sourceProfile: SOURCE_USER_DATA_DIR,
  clonedProfile: process.env.META_OAUTH_USE_PROFILE_CLONE !== '0',
  existingAccountCount: existingAccounts.length,
  configuredTokenPresent: Boolean(configuredMetaToken(env)),
  configuredPasswordPresent: Boolean(configuredMetaPassword(env)),
}, null, 2));

try {
  const token = configuredMetaToken(env) || await getTokenWithWeles(appId, env);
  const accounts = await fetchAdAccounts(token);
  if (!accounts.length) throw new Error('token is valid, but no Meta ad accounts are accessible');

  const upserted = [];
  for (const account of accounts) {
    const body = [{
      user_id: primary.user_id,
      platform: 'meta',
      account_id: account.account_id,
      account_name: account.name || primary.account_name || 'Meta Ads',
      access_token: token,
      refresh_token: null,
      currency: account.currency || primary.currency || 'USD',
      is_active: true,
      metadata: {
        ...(primary.metadata || {}),
        app_id: appId,
        platform_id: account.id,
        account_status: String(account.account_status),
      },
      updated_at: new Date().toISOString(),
    }];
    const rows = await supabaseFetch(
      env,
      '/ad_accounts?on_conflict=user_id,platform,account_id&select=id,account_id,account_name,currency',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=representation',
        },
        body: JSON.stringify(body),
      },
    );
    upserted.push(...rows);
  }

  const reach = [];
  for (const account of accounts) {
    reach.push({
      accountId: account.account_id,
      accountName: account.name,
      ...(await fetchReach(account.id, token)),
    });
  }

  console.log(JSON.stringify({
    stage: 'connected',
    connectedAccountCount: upserted.length,
    accounts: upserted,
    reach,
  }, null, 2));
  console.log('PASS: Meta Ads connected to Echo');
} catch (error) {
  console.log(`FAIL: ${error.message || String(error)}`);
  process.exit(1);
}
