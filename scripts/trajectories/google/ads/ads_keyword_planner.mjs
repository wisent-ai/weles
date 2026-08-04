// Google Ads UI fallback: collect Keyword Planner keyword volume without
// REST keyword-planning service access.
//
// Env:
//   GOOGLE_ADS_CUSTOMER_ID       required
//   GOOGLE_ADS_KEYWORDS          required, comma/newline separated
//   GOOGLE_ADS_RESULT_FILE       optional JSON output path
//   GOOGLE_ADS_EMAIL / SSO_EMAIL optional, defaults to lukasz.bartoszcze@wisent.ai

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generatePersona } from '../../../../dist/browser/persona.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { googleSso, getGoogleSsoCreds } from '../../_shared/services/google_sso.mjs';
import { assertGoogleAdsProfileNotAlreadyOpen, closeAllowedByEnv } from './_profile_guard.mjs';

const DEFAULT_GOOGLE_ADS_EMAIL = 'lukasz.bartoszcze@wisent.ai';
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || 60 * 1000);
const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'google_ads');
const DIAG_DIR = process.env.GOOGLE_ADS_DIAG_DIR || '.work/google-ads-keyword-planner';
const RESULT_FILE = process.env.GOOGLE_ADS_RESULT_FILE || join(DIAG_DIR, 'keyword-planner.json');
const CLOSE_AFTER_HARVEST = closeAllowedByEnv('GOOGLE_ADS_CLOSE_AFTER_HARVEST');
const cid = normalizeCustomerId(process.env.GOOGLE_ADS_CUSTOMER_ID || '');
const keywords = parseKeywords(process.env.GOOGLE_ADS_KEYWORDS || process.env.KEYWORDS || process.env.KEYWORD || '');
let authFailure = null;

if (!cid) throw new Error('GOOGLE_ADS_CUSTOMER_ID required');
if (!keywords.length) throw new Error('GOOGLE_ADS_KEYWORDS required');

mkdirSync(USER_DATA_DIR, { recursive: true });
mkdirSync(DIAG_DIR, { recursive: true });

process.env.WELES_CAPTURE_RESPONSE_BODIES ??= '1';
process.env.WELES_DISABLE_RECORDING ??= '1';
process.env.WELES_NO_INSTRUMENT ??= '1';
process.env.WELES_VIEWPORT ??= '1440x1000';
process.env.GOOGLE_SSO_NO_SCREENSHOTS ??= '1';

function parseKeywords(value) {
  return [...new Set(String(value || '')
    .split(/[\n,]+/)
    .map((keyword) => keyword.trim())
    .filter(Boolean))];
}

function normalizeCustomerId(value) {
  return String(value || '').replace(/\D/g, '');
}

function dashedCustomerId(value) {
  const id = normalizeCustomerId(value);
  if (id.length !== 10) return id;
  return `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}`;
}

function norm(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function preferredGoogleAdsEmail() {
  return process.env.GOOGLE_ADS_EMAIL || process.env.SSO_EMAIL || process.env.GM_EMAIL || DEFAULT_GOOGLE_ADS_EMAIL;
}

function stableProfilePersona() {
  const p = join(USER_DATA_DIR, 'persona.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const persona = generatePersona({ os: 'macos', browser: 'chromium' });
  writeFileSync(p, JSON.stringify(persona, null, 2));
  return persona;
}

function loadEnvFile(file) {
  if (!existsSync(file)) return {};
  const env = {};
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals < 0) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function applyEnvDefaults(env) {
  for (const [key, value] of Object.entries(env)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

async function resolveSsoCreds() {
  applyEnvDefaults(loadEnvFile(join(process.cwd(), '.env')));
  applyEnvDefaults(loadEnvFile(join(process.cwd(), '.env.local')));
  applyEnvDefaults(loadEnvFile(join(process.cwd(), '.env.production')));
  applyEnvDefaults(loadEnvFile(join(process.cwd(), '..', 'echo', '.env.local')));
  applyEnvDefaults(loadEnvFile(join(process.cwd(), '..', 'echo', '.env.production')));
  const fileEnvs = [
    loadEnvFile(join(process.cwd(), '.work', '_sso.env')),
    loadEnvFile(join(process.cwd(), '..', 'weles', '.work', '_sso.env')),
  ];
  const email = preferredGoogleAdsEmail();
  const fromDb = await getGoogleSsoCreds(email).catch(() => null);
  const processPassword = process.env.SSO_PASS || process.env.SSO_PASSWORD || process.env.GM_PASSWORD;
  if (processPassword) {
    const processEmail = process.env.SSO_EMAIL || process.env.GOOGLE_ADS_EMAIL || process.env.GM_EMAIL || email;
    if (processEmail.toLowerCase() === email.toLowerCase()) {
      return {
        email,
        password: processPassword,
        ...(fromDb?.totpSecret ? { totpSecret: fromDb.totpSecret } : {}),
        source: fromDb?.totpSecret ? 'env+service_credentials_totp' : 'env',
      };
    }
  }
  for (const fileEnv of fileEnvs) {
    const filePassword = fileEnv.SSO_PASS || fileEnv.SSO_PASSWORD || fileEnv.GM_PASSWORD;
    if (!filePassword) continue;
    const fileEmail = fileEnv.SSO_EMAIL || fileEnv.GOOGLE_ADS_EMAIL || fileEnv.GM_EMAIL || email;
    if (fileEmail.toLowerCase() === email.toLowerCase()) {
      return {
        email,
        password: filePassword,
        ...(fromDb?.totpSecret ? { totpSecret: fromDb.totpSecret } : {}),
        source: fromDb?.totpSecret ? 'file_env+service_credentials_totp' : 'file_env',
      };
    }
  }
  if (fromDb?.password) return { ...fromDb, source: 'service_credentials' };
  const sharedPasswordEmail = process.env.GOOGLE_ADS_SHARED_PASSWORD_EMAIL || '';
  if (sharedPasswordEmail && sharedPasswordEmail.toLowerCase() !== email.toLowerCase()) {
    const shared = await getGoogleSsoCreds(sharedPasswordEmail).catch(() => null);
    if (shared?.password) {
      return {
        email,
        password: shared.password,
        source: `shared_google_password:${sharedPasswordEmail}`,
      };
    }
  }
  return null;
}

function hasGoogleAuthCookie(cookies) {
  const names = new Set(cookies.filter((c) => /google\.com$|\.google\.com$/.test(c.domain || '')).map((c) => c.name));
  return names.has('SID') || names.has('__Secure-1PSID') || names.has('__Secure-3PSID');
}

function isLoginUrl(url) {
  return /accounts\.google\.com|ServiceLogin|signin/i.test(url);
}

async function clickUseAnotherGoogleAccount(page) {
  const useAnother = page.getByText(/^Use another account$/i)
    .or(page.getByText(/^Add another account$/i))
    .or(page.getByText(/^Use another Google Account$/i))
    .first();
  if (await useAnother.isVisible().catch(() => false)) {
    console.log('[google-ads-keyword-planner] choosing "Use another account"');
    await humanClickLocator(page, useAnother);
    await humanIdlePause('deliberate');
    return true;
  }
  return false;
}

async function continueFromAccountChooser(s) {
  const current = s.page.url?.() ?? '';
  if (!/accounts\.google\.com/.test(current)) return false;
  const cookies = await s.ctx.cookies().catch(() => []);
  if (!hasGoogleAuthCookie(cookies)) return false;
  const email = preferredGoogleAdsEmail();
  const preferred = s.page.getByText(email, { exact: false }).filter({ visible: true }).first();
  if (await preferred.isVisible().catch(() => false)) {
    console.log(`[google-ads-keyword-planner] selecting persisted account ${email}`);
    await humanClickLocator(s.page, preferred);
    await humanIdlePause('deliberate');
    return true;
  }
  return false;
}

async function navigateGoogleIdentifier(page, email, returnUrl) {
  const login = new URL('https://accounts.google.com/signin/v2/identifier');
  login.searchParams.set('service', 'adwords');
  login.searchParams.set('continue', returnUrl);
  login.searchParams.set('flowName', 'GlifWebSignIn');
  login.searchParams.set('flowEntry', 'ServiceLogin');
  login.searchParams.set('Email', email);
  await page.goto(login.toString(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch((error) => {
    console.log(`[google-ads-keyword-planner] WARN: identifier navigation failed ${String(error?.message || error).slice(0, 240)}`);
  });
  await humanIdlePause('deliberate');
}

async function runPreferredGoogleSso(s, returnUrl) {
  const email = preferredGoogleAdsEmail();
  const creds = await resolveSsoCreds();
  if (!creds?.password) {
    console.log(`[google-ads-keyword-planner] FAIL: no SSO credentials available for ${email}`);
    authFailure = {
      blocked: 'missing_google_sso_credentials',
      email,
      detail: 'No matching SSO_PASS/SSO_PASSWORD/GM_PASSWORD env or service_credentials row exists for this email.',
    };
    return false;
  }

  if (/accounts\.google\.com/.test(s.page.url?.() || '')) {
    const emailInputCount = await s.page.locator('input[type="email"], input[name="identifier"], input#identifierId')
      .filter({ visible: true })
      .count()
      .catch(() => 0);
    if (!emailInputCount) {
      await clickUseAnotherGoogleAccount(s.page);
      await humanIdlePause('deliberate');
    }
  }

  const emailInputCount = await s.page.locator('input[type="email"], input[name="identifier"], input#identifierId')
    .filter({ visible: true })
    .count()
    .catch(() => 0);
  if (!/accounts\.google\.com/.test(s.page.url?.() || '') || !emailInputCount) {
    await navigateGoogleIdentifier(s.page, email, returnUrl);
  }

  console.log(`[google-ads-keyword-planner] running automated Google SSO for ${creds.email} source=${creds.source || 'unknown'}`);
  const ok = await googleSso(s, creds, { originHost: 'ads.google.com' });
  if (!ok) {
    authFailure = {
      blocked: 'google_sso_failed',
      email: creds.email,
      source: creds.source || 'unknown',
      detail: 'Google SSO helper did not complete login.',
    };
    return false;
  }
  if (!/ads\.google\.com/.test(s.page.url?.() || '')) {
    await s.page.goto(returnUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch((error) => {
      console.log(`[google-ads-keyword-planner] WARN: post-SSO return navigation failed ${String(error?.message || error).slice(0, 240)}`);
    });
  }
  await s.wait(8);
  return true;
}

async function ensurePreferredGoogleAccount(s, returnUrl) {
  const email = preferredGoogleAdsEmail();
  if (/accounts\.google\.com/.test(s.page.url?.() || '')) {
    const selectedPersisted = await continueFromAccountChooser(s);
    if (selectedPersisted) {
      await s.wait(8);
      if (!/accounts\.google\.com/.test(s.page.url?.() || '')) return true;
    }
    return await runPreferredGoogleSso(s, returnUrl);
  }
  const text = await s.page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (text.includes(email)) return true;
  const chooser = new URL('https://accounts.google.com/AccountChooser');
  chooser.searchParams.set('Email', email);
  chooser.searchParams.set('continue', returnUrl);
  chooser.searchParams.set('service', 'adwords');
  await s.page.goto(chooser.toString(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch((error) => {
    console.log(`[google-ads-keyword-planner] WARN: account chooser navigation failed ${String(error?.message || error).slice(0, 240)}`);
  });
  await s.wait(5);
  const selectedPersisted = await continueFromAccountChooser(s);
  if (!selectedPersisted) return await runPreferredGoogleSso(s, returnUrl);
  await s.wait(8);
  return true;
}

function campaignsUrl(paramName, target, authuser = preferredGoogleAdsEmail()) {
  const url = new URL('https://ads.google.com/aw/campaigns');
  url.searchParams.set(paramName, normalizeCustomerId(target));
  if (authuser) url.searchParams.set('authuser', authuser);
  return url.toString();
}

function buildGoogleAdsPath(current, pathname) {
  const source = new URL(current || campaignsUrl('cid', cid));
  const target = new URL(pathname, 'https://ads.google.com');
  for (const key of ['ocid', 'authuser', '__u', '__c', 'uscid', 'euid', 'cid', '__e']) {
    const value = source.searchParams.get(key);
    if (value) target.searchParams.set(key, value);
  }
  target.searchParams.set('authuser', preferredGoogleAdsEmail());
  if (!target.searchParams.get('cid')) target.searchParams.set('cid', cid);
  return target.toString();
}

function installKeywordPlannerCapture(page) {
  const requests = [];
  const responses = [];
  page.on('request', (request) => {
    try {
      const url = request.url();
      if (!/ads\.google\.com/i.test(url)) return;
      if (!/(keyword|planner|idea|forecast|plan|targeting|batch|rpc|AwAdsGuide)/i.test(url)) return;
      const headers = request.headers();
      requests.push({
        ts: Date.now(),
        method: request.method(),
        url,
        postData: String(request.postData() || '').slice(0, 1000000),
        replayHeaders: {
          'x-framework-xsrf-token': headers['x-framework-xsrf-token'] || '',
          'x-same-domain': headers['x-same-domain'] || '',
        },
      });
      if (requests.length > 300) requests.shift();
    } catch {}
  });
  page.on('response', (response) => {
    void (async () => {
      try {
        const url = response.url();
        if (!/ads\.google\.com/i.test(url)) return;
        if (!/(keyword|planner|idea|forecast|plan|targeting|batch|rpc|AwAdsGuide)/i.test(url)) return;
        const headers = response.headers();
        const contentType = String(headers['content-type'] || '');
        let body = '';
        if (/json|text|javascript|html|xml|x-www-form-urlencoded/i.test(contentType)) {
          body = (await response.text().catch(() => '')).slice(0, 1000000);
        }
        const parsedUrl = new URL(url);
        responses.push({
          ts: Date.now(),
          method: response.request()?.method?.() || 'GET',
          endpoint: `${parsedUrl.origin}${parsedUrl.pathname}`,
          status: response.status(),
          contentType,
          body,
        });
        if (responses.length > 300) responses.shift();
      } catch {}
    })();
  });
  return { requests, responses };
}

function stripJsonPrefix(text) {
  return String(text || '').replace(/^\)\]\}'\s*\n?/, '');
}

function parseJson(text) {
  try {
    return JSON.parse(stripJsonPrefix(text));
  } catch {
    return null;
  }
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function walk(value, visit, path = []) {
  visit(value, path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, path.concat(String(index))));
    return;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) walk(child, visit, path.concat(key));
  }
}

function summarizeKeywordPlannerResponses(responses) {
  const endpointCounts = {};
  const keywordMentions = [];
  const metricsMentions = [];
  const numericMentions = [];
  const keywordPatterns = keywords.map((keyword) => new RegExp(keyword.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i'));

  for (const response of responses) {
    const endpointName = response.endpoint.split('/').slice(-3).join('/');
    endpointCounts[endpointName] = (endpointCounts[endpointName] || 0) + 1;
    const parsed = parseJson(response.body);
    if (!parsed) continue;
    walk(parsed, (value, path) => {
      if (typeof value === 'string') {
        const compact = norm(value);
        if (!compact || compact.length > 300) return;
        if (keywordPatterns.some((pattern) => pattern.test(compact))) {
          keywordMentions.push({ endpoint: endpointName, path: path.join('.'), value: compact });
        }
        if (/avg|monthly|search|competition|bid|forecast|click|impression|volume/i.test(compact)) {
          metricsMentions.push({ endpoint: endpointName, path: path.join('.'), value: compact });
        }
      }
      if (typeof value === 'number' && Number.isFinite(value) && value !== 0) {
        numericMentions.push({ endpoint: endpointName, path: path.join('.'), value });
      }
    });
  }

  return {
    responseCount: responses.length,
    endpointCounts,
    keywordMentions: keywordMentions.slice(0, 200),
    metricsMentions: metricsMentions.slice(0, 200),
    numericMentions: numericMentions.slice(0, 300),
  };
}

async function collectDom(page) {
  return await page.evaluate(() => {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect?.();
      if (!rect || rect.width < 2 || rect.height < 2) return false;
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') === 0) return false;
      return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
    };
    const nodes = [];
    const seen = new Set();
    const visit = (root) => {
      for (const el of root.querySelectorAll?.('*') || []) {
        if (seen.has(el)) continue;
        seen.add(el);
        nodes.push(el);
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(document);
    const rows = nodes
      .filter((el) => visible(el) && (/^(tr|material-list-item)$/i.test(el.tagName || '') || el.getAttribute?.('role') === 'row'))
      .map((row) => norm(row.innerText || row.textContent || ''))
      .filter(Boolean)
      .slice(0, 300);
    const controls = nodes
      .filter((el) => visible(el) && (/^(a|button|input|textarea|material-button)$/i.test(el.tagName || '') || /button|menuitem|textbox/i.test(el.getAttribute?.('role') || '') || el.getAttribute?.('aria-label')))
      .map((el) => ({
        tag: (el.tagName || '').toLowerCase(),
        role: el.getAttribute?.('role') || '',
        text: norm(el.innerText || el.textContent || '').slice(0, 300),
        aria: el.getAttribute?.('aria-label') || '',
        title: el.getAttribute?.('title') || '',
        placeholder: el.getAttribute?.('placeholder') || '',
        value: norm(el.value || '').slice(0, 300),
      }))
      .filter((control) => /keyword|planner|search|forecast|volume|result|product|service|website|language|location|competition|bid|start|get|discover/i.test(`${control.text} ${control.aria} ${control.title} ${control.placeholder} ${control.value}`))
      .slice(0, 300);
    return {
      url: location.href,
      title: document.title,
      text: norm(document.body?.innerText || ''),
      rows,
      controls,
    };
  }).catch(() => ({ url: '', title: '', text: '', rows: [], controls: [] }));
}

function parseVolumeText(value) {
  const text = norm(value);
  const range = text.match(/\b(\d+(?:[,.]\d+)?\s*[KM]?)\s*(?:-|–|to)\s*(\d+(?:[,.]\d+)?\s*[KM]?)\b/i);
  if (range) return range[0].replace(/\s+/g, ' ');
  const number = text.match(/\b\d+(?:[,.]\d+)?\s*[KM]?\b/i);
  return number ? number[0].replace(/\s+/g, ' ') : null;
}

function parseKeywordRows(rows) {
  const parsed = [];
  for (const row of rows.map(norm).filter(Boolean)) {
    const matchedKeyword = keywords.find((keyword) => row.toLowerCase().includes(keyword.toLowerCase()));
    if (!matchedKeyword) continue;
    const volume = parseVolumeText(row);
    const competition = row.match(/\b(Low|Medium|High)\b/i)?.[1] || null;
    const bidMentions = [...row.matchAll(/(?:US)?[$£€]\s?\d+(?:[,.]\d+)?/g)].map((match) => match[0]);
    parsed.push({
      keyword: matchedKeyword,
      averageMonthlySearchesText: volume,
      competition,
      bidMentions,
      raw: row,
    });
  }
  return parsed;
}

async function clickByText(page, pattern, label) {
  const control = page.getByRole('button', { name: pattern }).filter({ visible: true }).first()
    .or(page.getByRole('link', { name: pattern }).filter({ visible: true }).first())
    .or(page.getByText(pattern).filter({ visible: true }).first());
  if (await control.isVisible().catch(() => false)) {
    console.log(`[google-ads-keyword-planner] clicking ${label}`);
    await humanClickLocator(page, control);
    await humanIdlePause('deliberate');
    return true;
  }
  return false;
}

async function continueFromGoogleAdsAccountSelector(page) {
  if (!/ads\.google\.com\/nav\/selectaccount/i.test(page.url?.() || '')) return false;
  const dashed = dashedCustomerId(cid);
  const candidates = [
    page.getByText(new RegExp(dashed.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'))).filter({ visible: true }).first(),
    page.getByText(/Wisent-AI, Inc/i).filter({ visible: true }).first(),
    page.getByText(/Google Ads account/i).filter({ visible: true }).first(),
  ];
  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) {
      console.log(`[google-ads-keyword-planner] selecting Google Ads account ${dashed}`);
      await humanClickLocator(page, candidate);
      await humanIdlePause('deliberate');
      return true;
    }
  }
  return false;
}

async function fillKeywordInput(page) {
  const text = keywords.join('\n');
  const result = await page.evaluate(({ text }) => {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect?.();
      if (!rect || rect.width < 4 || rect.height < 4) return false;
      const style = window.getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') !== 0;
    };
    const candidates = [];
    const seen = new Set();
    const visit = (root) => {
      for (const el of root.querySelectorAll?.('textarea,input,[contenteditable="true"],[role="textbox"]') || []) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (el.shadowRoot) visit(el.shadowRoot);
        if (!visible(el)) continue;
        const descriptor = norm([
          el.getAttribute?.('aria-label') || '',
          el.getAttribute?.('placeholder') || '',
          el.getAttribute?.('title') || '',
          el.closest?.('label')?.innerText || '',
          el.parentElement?.innerText || '',
        ].join(' '));
        let score = 0;
        if (/keyword|products?|services?|search terms?|phrases?/i.test(descriptor)) score += 20;
        if (/website|domain|url|landing page/i.test(descriptor)) score -= 30;
        if ((el.tagName || '').toLowerCase() === 'textarea') score += 8;
        if (el.getAttribute?.('role') === 'textbox') score += 5;
        candidates.push({ el, descriptor, score });
      }
    };
    visit(document);
    candidates.sort((a, b) => b.score - a.score);
    const selected = candidates.find((candidate) => candidate.score > 0) || candidates[0];
    if (!selected) return { ok: false, reason: 'no_keyword_input' };
    const el = selected.el;
    el.focus();
    if ('value' in el) {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
    return {
      ok: true,
      descriptor: selected.descriptor.slice(0, 300),
      tag: (el.tagName || '').toLowerCase(),
      role: el.getAttribute?.('role') || '',
    };
  }, { text });
  if (result?.ok) {
    console.log(`[google-ads-keyword-planner] filled keyword input ${JSON.stringify(result)}`);
    await humanIdlePause('deliberate');
    return result;
  }

  const fallback = page.locator('textarea, input[type="text"], input:not([type]), [contenteditable="true"], [role="textbox"]')
    .filter({ visible: true })
    .first();
  if (await fallback.isVisible().catch(() => false)) {
    await fallback.fill(text).catch(async () => {
      await fallback.click().catch(() => {});
      await page.keyboard.insertText(text);
    });
    await humanIdlePause('deliberate');
    return { ok: true, descriptor: 'playwright_fallback' };
  }
  return result || { ok: false, reason: 'no_keyword_input' };
}

async function openKeywordPlanner(s) {
  const candidates = [
    '/aw/keywordplanner/home',
    '/aw/keywordplanner/ideas/new',
    '/aw/keywordplanner/ideas',
    '/aw/keywordplanner',
  ];
  const attempts = [];
  for (const path of candidates) {
    const url = buildGoogleAdsPath(s.page.url?.() || campaignsUrl('cid', cid), path);
    await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch((error) => {
      console.log(`[google-ads-keyword-planner] WARN: planner navigation failed ${path} ${String(error?.message || error).slice(0, 240)}`);
    });
    await s.wait(8);
    if (await continueFromGoogleAdsAccountSelector(s.page)) {
      await s.wait(8);
    }
    const dom = await collectDom(s.page);
    const matched = /keyword planner|discover new keywords|get search volume|forecasts?|keyword ideas|avg\.? monthly searches/i.test(dom.text);
    attempts.push({ path, url: dom.url || url, matched, textPreview: norm(dom.text).slice(0, 800), controls: dom.controls.slice(0, 20) });
    if (matched) return { ok: true, path, attempts };
  }
  const clickedTools = await clickByText(s.page, /Tools|Tools and settings|Planning|Keyword Planner/i, 'tools/planning navigation');
  if (clickedTools) {
    await clickByText(s.page, /Keyword Planner/i, 'Keyword Planner');
    await s.wait(8);
    const dom = await collectDom(s.page);
    const matched = /keyword planner|discover new keywords|get search volume|forecasts?|keyword ideas|avg\.? monthly searches/i.test(dom.text);
    attempts.push({ path: 'menu_keyword_planner', url: dom.url, matched, textPreview: norm(dom.text).slice(0, 800), controls: dom.controls.slice(0, 20) });
    if (matched) return { ok: true, path: 'menu_keyword_planner', attempts };
  }
  return { ok: false, attempts };
}

async function collectKeywordPlanner(s, captured) {
  const before = await collectDom(s.page);
  await clickByText(s.page, /Discover new keywords|Get search volume and forecasts|Get search volume|Start with keywords/i, 'keyword planner mode');
  await s.wait(3);
  const fill = await fillKeywordInput(s.page);
  const actionClicks = [];
  for (const action of [
    { label: 'Get results', pattern: /Get results/i },
    { label: 'See results', pattern: /See results/i },
    { label: 'View results', pattern: /View results/i },
    { label: 'Start', pattern: /Start|Get started/i },
    { label: 'Search', pattern: /^Search$/i },
  ]) {
    const clicked = await clickByText(s.page, action.pattern, action.label);
    actionClicks.push({ label: action.label, clicked });
    if (clicked) {
      await s.wait(12);
      break;
    }
  }
  await s.wait(8);
  const after = await collectDom(s.page);
  const rows = [...before.rows, ...after.rows];
  const parsedRows = parseKeywordRows(rows);
  return {
    customer: cid,
    customerDashed: dashedCustomerId(cid),
    preferredEmail: preferredGoogleAdsEmail(),
    keywords,
    url: s.page.url?.() || '',
    capturedAt: new Date().toISOString(),
    fill,
    actionClicks,
    rows: after.rows,
    controls: after.controls,
    parsedRows,
    visibleTextPreview: norm(after.text).slice(0, 3000),
    rpc: summarizeKeywordPlannerResponses(captured.responses),
    capturedRequestCount: captured.requests.length,
    capturedResponseCount: captured.responses.length,
    source: 'google_ads_keyword_planner_ui',
  };
}

async function main() {
  console.log(`[google-ads-keyword-planner] customer=${cid} keywords=${JSON.stringify(keywords)}`);
  const startUrl = campaignsUrl('cid', cid);
  assertGoogleAdsProfileNotAlreadyOpen(USER_DATA_DIR, 'google_ads_keyword_planner');
  const s = await WSession.start({
    label: 'google_ads_keyword_planner',
    browser: process.env.BROWSER || 'chromium',
    proxy: process.env.PROXY_URL || 'direct',
    persona: stableProfilePersona(),
    userDataDir: USER_DATA_DIR,
    pageDiagnostics: process.env.WELES_PAGE_DIAGNOSTICS === '1',
  });
  const captured = installKeywordPlannerCapture(s.page);
  try {
    await s.page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch((error) => {
      console.log(`[google-ads-keyword-planner] WARN: initial navigation failed ${String(error?.message || error).slice(0, 240)}`);
    });
    await s.wait(8);
    await ensurePreferredGoogleAccount(s, startUrl);
    await continueFromAccountChooser(s);
    await s.wait(5);

    const current = s.page.url?.() || '';
    const text = await s.page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (isLoginUrl(current)) {
      const report = {
        ok: false,
        blocked: authFailure?.blocked || 'google_ads_browser_session_not_logged_in',
        customer: cid,
        keywords,
        url: current,
        authFailure,
        textPreview: norm(text).slice(0, 1200),
      };
      writeFileSync(RESULT_FILE, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report, null, 2));
      process.exit(2);
    }
    if (/multifactorauthalert|block=true/i.test(current) || /multi-factor|2-step verification|2-Step Verification/i.test(text)) {
      const report = {
        ok: false,
        blocked: 'google_ads_mfa_required',
        customer: cid,
        keywords,
        url: current,
        textPreview: norm(text).slice(0, 1200),
      };
      writeFileSync(RESULT_FILE, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report, null, 2));
      process.exit(3);
    }

    const open = await openKeywordPlanner(s);
    if (!open.ok) {
      const report = {
        ok: false,
        blocked: 'keyword_planner_not_opened',
        customer: cid,
        keywords,
        open,
        url: s.page.url?.() || '',
      };
      writeFileSync(RESULT_FILE, JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report, null, 2).slice(0, 12000));
      process.exit(4);
    }

    const report = await collectKeywordPlanner(s, captured);
    report.open = open;
    report.ok = report.parsedRows.length > 0 || report.rpc.keywordMentions.length > 0;
    writeFileSync(RESULT_FILE, JSON.stringify(report, null, 2));
    console.log(`GOOGLE_ADS_KEYWORD_PLANNER_REPORT ${JSON.stringify(report)}`);
    console.log(JSON.stringify(report, null, 2).slice(0, 20000));
    console.log('PASS: Google Ads keyword planner read completed (browser)');
  } finally {
    if (CLOSE_AFTER_HARVEST) await s.close().catch(() => {});
    else console.log('[google-ads-keyword-planner] leaving Google Ads profile open');
  }
}

main().catch((error) => {
  const report = {
    ok: false,
    blocked: 'google_ads_keyword_planner_error',
    customer: cid,
    keywords,
    error: String(error?.message || error),
  };
  writeFileSync(RESULT_FILE, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
});
