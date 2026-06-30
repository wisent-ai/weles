// Google Ads Keyword Planner through the persistent Weles keeper.
// Do not reimplement this path with REST/developer-credential access;
// keyword-volume collection for reports is intentionally UI-observed via Weles.
// No CUA. No CDP attach. No short-lived WSession/profile launch.
// The keeper owns the browser/profile; this runner drives it through the socket.
//
// Env:
//   GOOGLE_ADS_CUSTOMER_ID       required
//   GOOGLE_ADS_KEYWORDS          required, comma/newline separated
//   GOOGLE_ADS_RESULT_FILE       optional JSON output path
//   SESSION                      optional keeper session, default google_ads
//   GOOGLE_ADS_EMAIL / SSO_EMAIL optional, defaults to lukasz.bartoszcze@wisent.ai

import net from 'node:net';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { generateTotp, getGoogleSsoCreds } from '../../_shared/services/google_sso.mjs';

const DEFAULT_EMAIL = 'lukasz.bartoszcze@wisent.ai';
const SESSION = process.env.SESSION || process.env.GOOGLE_ADS_KEEPER_SESSION || 'google_ads';
const SOCK = join(homedir(), '.weles', 'keeper', SESSION, 'socket');
const DIAG_DIR = process.env.GOOGLE_ADS_DIAG_DIR || '.work/google-ads-keyword-planner';
const RESULT_FILE = process.env.GOOGLE_ADS_RESULT_FILE || join(DIAG_DIR, `keywords-${normalizeCustomerId(process.env.GOOGLE_ADS_CUSTOMER_ID || '') || 'unknown'}.json`);
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || 60_000);
const ACTION_TIMEOUT_MS = Number(process.env.GOOGLE_ADS_KEEPER_ACTION_TIMEOUT_MS || 90_000);
const cid = normalizeCustomerId(process.env.GOOGLE_ADS_CUSTOMER_ID || '');
const keywords = parseKeywords(process.env.GOOGLE_ADS_KEYWORDS || process.env.KEYWORDS || process.env.KEYWORD || '');

if (!cid) throw new Error('GOOGLE_ADS_CUSTOMER_ID required');
if (!keywords.length) throw new Error('GOOGLE_ADS_KEYWORDS required');
mkdirSync(DIAG_DIR, { recursive: true });
mkdirSync(dirname(RESULT_FILE), { recursive: true });

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[key] = value;
  }
  return env;
}

function applyEnvDefaults(env) {
  for (const [key, value] of Object.entries(env)) if (!process.env[key]) process.env[key] = value;
}

function parseKeywords(value) {
  return [...new Set(String(value || '').split(/[\n,]+/).map((keyword) => keyword.trim()).filter(Boolean))];
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

function preferredEmail() {
  return process.env.GOOGLE_ADS_EMAIL || process.env.SSO_EMAIL || process.env.GM_EMAIL || DEFAULT_EMAIL;
}

async function resolveSsoCreds() {
  const email = preferredEmail();
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

  const fileEnvs = [
    loadEnvFile(join(process.cwd(), '.work', '_sso.env')),
    loadEnvFile(join(process.cwd(), '..', 'weles', '.work', '_sso.env')),
  ];
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
        ...(shared?.totpSecret ? { totpSecret: shared.totpSecret } : {}),
        source: `shared_google_password:${sharedPasswordEmail}`,
      };
    }
  }
  if (!process.env.GOOGLE_ADS_EMAIL && !process.env.SSO_EMAIL && !process.env.GM_EMAIL) {
    const fallback = await getGoogleSsoCreds().catch(() => null);
    if (fallback?.password) return { ...fallback, source: 'service_credentials_default_email' };
  }

  return null;
}

function redact(text) {
  return String(text || '')
    .replace(/[A-Z2-7](?:\s?[A-Z2-7]){15,}/g, '<redacted-base32-secret>')
    .replace(/Warszawa\d*!?/g, '<redacted-password>')
    .replace(/"login_password"\s*:\s*"[^"]+"/g, '"login_password":"<redacted>"')
    .replace(/"google_totp_secret"\s*:\s*"[^"]+"/g, '"google_totp_secret":"<redacted>"');
}

function writeResult(report, code = 0) {
  const safe = JSON.parse(redact(JSON.stringify(report)));
  writeFileSync(RESULT_FILE, JSON.stringify(safe, null, 2));
  console.log(JSON.stringify(safe, null, 2));
  process.exit(code);
}

function socketReady() {
  return existsSync(SOCK);
}

function action(cmd, timeoutMs = ACTION_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(SOCK);
    let done = false;
    let buf = '';
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { conn.destroy(); } catch {}
      reject(new Error(`keeper action timeout: ${cmd.action}`));
    }, timeoutMs);
    conn.on('connect', () => conn.write(`${JSON.stringify(cmd)}\n`));
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0 || done) return;
      done = true;
      clearTimeout(timer);
      conn.end();
      try {
        const parsed = JSON.parse(buf.slice(0, nl));
        if (!parsed.ok) reject(new Error(parsed.error || `keeper action failed: ${cmd.action}`));
        else resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });
    conn.on('error', (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function idle(kind = 'deliberate') {
  await action({ action: 'humanidle', kind }, 30_000).catch(() => {});
}

async function nav(url) {
  await action({ action: 'nav', url }, Math.max(NAV_TIMEOUT_MS, 120_000));
  await idle('deliberate');
}

async function evalState(limit = 14_000) {
  const res = await action({
    action: 'eval',
    js: `(() => {
      const norm = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => {
        const r = el.getBoundingClientRect?.();
        if (!r || r.width < 2 || r.height < 2) return false;
        const st = getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity || '1') !== 0;
      };
      return {
        url: location.href,
        title: document.title,
        text: (document.body?.innerText || '').slice(0, ${Number(limit)}),
        inputs: Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"]')).map((el) => ({
          tag: (el.tagName || '').toLowerCase(),
          type: el.getAttribute('type') || '',
          name: el.getAttribute('name') || '',
          role: el.getAttribute('role') || '',
          aria: el.getAttribute('aria-label') || '',
          placeholder: el.getAttribute('placeholder') || '',
          value: String(el.value || el.textContent || '').slice(0, 300),
          visible: visible(el),
        })).slice(0, 80),
        controls: Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], a, [role="link"], li, div[role="option"], material-button, material-list-item')).map((el) => {
          const r = el.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
          return {
            tag: (el.tagName || '').toLowerCase(),
            role: el.getAttribute('role') || '',
            text: norm(el.innerText || el.textContent || ''),
            aria: el.getAttribute('aria-label') || '',
            href: el.href || '',
            visible: visible(el),
            x: r.left,
            y: r.top,
            w: r.width,
            h: r.height,
          };
        }).filter((item) => item.visible && (item.text || item.aria || item.href)).slice(0, 180),
      };
    })()`,
  });
  return res.result || { url: '', title: '', text: '', inputs: [], controls: [] };
}

async function locateControl(patternSource, options = {}) {
  const source = JSON.stringify(patternSource);
  const minY = Number(options.minY ?? -10_000);
  const maxY = Number(options.maxY ?? 10_000);
  const maxArea = Number(options.maxArea ?? 1_000_000);
  const res = await action({
    action: 'eval',
    js: `(() => {
      const re = new RegExp(${source}, 'i');
      const norm = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => {
        const r = el.getBoundingClientRect?.();
        if (!r || r.width < 2 || r.height < 2) return false;
        const st = getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity || '1') !== 0;
      };
      const nodes = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], a, [role="link"], li, div[role="option"], material-button, material-list-item'));
      return nodes.map((el, index) => {
        const text = norm(el.innerText || el.textContent || '');
        const aria = el.getAttribute('aria-label') || '';
        const haystack = norm(text + ' ' + aria + ' ' + (el.href || ''));
        if (!visible(el) || !re.test(haystack)) return null;
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if (r.top < ${minY} || r.top > ${maxY} || area > ${maxArea}) return null;
        return { index, tag: (el.tagName || '').toLowerCase(), role: el.getAttribute('role') || '', text, aria, href: el.href || '', x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, area };
      }).filter(Boolean).sort((a, b) => a.area - b.area).slice(0, 20);
    })()`,
  });
  return res.result || [];
}

async function humanClickPoint(x, y, label) {
  console.log(`[google-ads-keyword-planner-keeper] clicking ${label} at ${Math.round(x)},${Math.round(y)}`);
  await action({ action: 'humanclick', x, y }, ACTION_TIMEOUT_MS);
  await idle('deliberate');
}

async function clickControl(patternSource, label, options = {}) {
  const matches = await locateControl(patternSource, options);
  if (!matches.length) return false;
  const target = matches[0];
  await humanClickPoint(target.cx, target.cy, label || target.text || target.aria || patternSource);
  return true;
}

async function fillSelector(selector, text, label) {
  console.log(`[google-ads-keyword-planner-keeper] filling ${label || selector}`);
  for (const fillAction of ['fill', 'fill_fast', 'set_value']) {
    try {
      await action({ action: fillAction, selector, text }, Math.min(ACTION_TIMEOUT_MS, 30_000));
    } catch (error) {
      const s = await evalState(4000).catch(() => null);
      const joined = JSON.stringify(s?.inputs || []);
      if (!joined.includes(text)) {
        if (fillAction === 'set_value') throw error;
        continue;
      }
    }
    await idle('deliberate');
    return true;
  }
  return false;
}

async function fillKeywordInput() {
  const text = keywords.join('\n');
  console.log('[google-ads-keyword-planner-keeper] filling keyword input');
  for (const selector of [
    'textarea[aria-label*="paste your keywords" i]',
    'textarea[aria-label*="keywords" i]',
    'textarea',
    '[role="textbox"][aria-label*="keywords" i]',
  ]) {
    for (const fillAction of ['set_value', 'fill_fast', 'fill']) {
      try {
        await action({ action: fillAction, selector, text }, Math.min(ACTION_TIMEOUT_MS, 30_000));
      } catch {
        continue;
      }
      await idle('deliberate');
      const s = await evalState(4000).catch(() => null);
      const joined = JSON.stringify(s?.inputs || []);
      if (joined.includes(text)) return true;
    }
  }
  return false;
}

async function press(key) {
  await action({ action: 'press', key }, 30_000);
  await idle('deliberate');
}

async function navigateStoredTotpChallenge(currentUrl) {
  if (!/accounts\.google\.com/i.test(currentUrl || '') || !/signin\/challenge\/selection/i.test(currentUrl || '')) return false;
  if (process.env.GOOGLE_SSO_ALLOW_DIRECT_TOTP !== '1') return false;
  const target = currentUrl.replace(/\/signin\/challenge\/selection(?=[?#])/, '/signin/challenge/totp');
  if (target === currentUrl) return false;
  const attempts = navigateStoredTotpChallenge.attempts || (navigateStoredTotpChallenge.attempts = new Set());
  const key = currentUrl.replace(/([?&](?:TL|rart|dsh)=)[^&]+/g, '$1');
  if (attempts.has(key)) return false;
  attempts.add(key);
  console.log('[google-ads-keyword-planner-keeper] opening Google Authenticator TOTP challenge directly');
  await nav(target);
  const next = await evalState(8000);
  if (next.inputs.some((input) => input.visible && /totpPin|Pin|one-time-code|numeric|tel/i.test(`${input.name} ${input.autocomplete} ${input.type}`))) return true;
  await nav(currentUrl);
  return false;
}

async function dismissChrome() {
  await action({
    action: 'eval',
    js: `(() => {
      const overlays = Array.from(document.querySelectorAll('.ad-blocker-detected-overlay, [class*="ad-blocker"], [class*="adblock"]'));
      for (const el of overlays) {
        el.style.pointerEvents = 'none';
        el.style.opacity = '0';
        el.style.display = 'none';
      }
      return overlays.length;
    })()`,
  }).catch(() => {});
  await clickControl('Close notifications|Get the Google Ads app dismiss|Close setup', 'dismiss overlay', { maxArea: 80_000 }).catch(() => false);
}

async function handleGoogleLogin(creds) {
  for (let step = 0; step < 45; step += 1) {
    const s = await evalState(8000);
    const text = s.text || '';
    const url = s.url || '';
    if (!/accounts\.google\.com/i.test(url)) return true;
    if (/session ended|not signed in|Try signing in again|Try again/i.test(text)) {
      await clickControl('Try again', 'session expired retry').catch(() => false);
      await idle('deliberate');
      continue;
    }

    if (s.inputs.some((input) => input.visible && /email|identifier/i.test(`${input.type} ${input.name} ${input.aria}`))) {
      await fillSelector('input[type="email"], input[name="identifier"], input#identifierId', creds.email || preferredEmail(), 'Google email');
      await clickControl('^Next$', 'email next').catch(async () => press('Enter'));
      continue;
    }

    if (s.inputs.some((input) => input.visible && /password|Passwd/i.test(`${input.type} ${input.name}`))) {
      await fillSelector('input[type="password"], input[name="Passwd"]', creds.password, 'Google password');
      await press('Enter');
      continue;
    }

    if (/Try another way|More ways to verify|Choose how you want to sign in|Tap Yes|Gmail app|phone or tablet/i.test(text) && !/Enter code|verification code from the Google Authenticator app/i.test(text)) {
      let after = s;
      if (/Try another way|More ways to verify/i.test(text)) {
        await clickControl('Try another way|More ways to verify', 'Try another way').catch(() => false);
        await idle('deliberate');
        after = await evalState(8000);
      }
      if (/Tap Yes on your phone|Gmail app|phone or tablet/i.test(after.text || '') && !/Try another way|More ways to verify/i.test(after.text || '')) {
        await clickControl('Tap Yes on your phone|Gmail app|phone or tablet', 'phone prompt option').catch(() => false);
        await idle('deliberate');
        continue;
      }
      if (creds?.totpSecret && /Authenticator|verification code/i.test(after.text || '')) {
        await clickControl('Google Authenticator|Authenticator|verification code', 'Authenticator option').catch(() => false);
        const code = generateTotp(creds.totpSecret);
        await fillSelector('input[type="tel"], input[type="text"], input[inputmode="numeric"], input[name="totpPin"], input[name="Pin"]', code, 'Google TOTP');
        await clickControl('^Next$|^Verify$', 'TOTP submit').catch(async () => press('Enter'));
        continue;
      }
      if (creds?.totpSecret && await navigateStoredTotpChallenge(after.url || url)) {
        const code = generateTotp(creds.totpSecret);
        await fillSelector('input[type="tel"], input[type="text"], input[inputmode="numeric"], input[name="totpPin"], input[name="Pin"]', code, 'Google TOTP');
        await clickControl('^Next$|^Verify$', 'TOTP submit').catch(async () => press('Enter'));
        continue;
      }
      continue;
    }

    if (/Enter code|verification code|Authenticator app/i.test(text) && creds?.totpSecret) {
      const code = generateTotp(creds.totpSecret);
      await fillSelector('input[type="tel"], input[type="text"], input[inputmode="numeric"], input[name="totpPin"], input[name="Pin"]', code, 'Google TOTP');
      await clickControl('^Next$|^Verify$', 'TOTP submit').catch(async () => press('Enter'));
      continue;
    }

    if (/Wrong code|Try again/i.test(text) && creds?.totpSecret) {
      const code = generateTotp(creds.totpSecret, { now: Date.now() + 31_000 });
      await fillSelector('input[type="tel"], input[type="text"], input[inputmode="numeric"], input[name="totpPin"], input[name="Pin"]', code, 'Google TOTP retry');
      await clickControl('^Next$|^Verify$', 'TOTP retry submit').catch(async () => press('Enter'));
      continue;
    }

    await idle('short');
  }
  return false;
}

function adsUrl(pathname) {
  const url = new URL(pathname, 'https://ads.google.com');
  url.searchParams.set('cid', cid);
  url.searchParams.set('authuser', process.env.GOOGLE_ADS_AUTHUSER || '1');
  return url.toString();
}

function savedPlannerUrls() {
  const files = [
    RESULT_FILE,
    join(DIAG_DIR, `keywords-${cid}.json`),
  ];
  try {
    for (const name of readdirSync(DIAG_DIR)) {
      if (name.endsWith('.json')) files.push(join(DIAG_DIR, name));
    }
  } catch {}

  const urls = [];
  for (const file of [...new Set(files)]) {
    if (!existsSync(file)) continue;
    try {
      const record = JSON.parse(readFileSync(file, 'utf8'));
      for (const candidate of [record?.url, record?.report?.url, record?.browser?.report?.url]) {
        if (/^https:\/\/ads\.google\.com\/aw\/keywordplanner\//i.test(candidate || '')) urls.push(candidate);
      }
    } catch {}
  }
  return [...new Set(urls)];
}

function plannerCandidates(paths) {
  return [...paths.map((path) => adsUrl(path)), ...savedPlannerUrls()];
}

async function selectGoogleAdsAccount() {
  const s = await evalState(6000);
  const text = s.text || '';
  if (!/Select a Google Ads account|Select an active account|No account|Google Ads account/i.test(text)) return true;
  const patterns = [dashedCustomerId(cid).replace(/-/g, '[- ]?'), cid, preferredEmail().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')];
  for (const pattern of patterns) {
    if (!await clickControl(pattern, 'Google Ads account', { maxArea: 500_000 }).catch(() => false)) continue;
    for (let i = 0; i < 12; i += 1) {
      await idle('short');
      const after = await evalState(4000);
      if (!/selectaccount/i.test(after.url || '') && !/Select a Google Ads account|Select an active account/i.test(after.text || '')) return true;
    }
  }
  return false;
}

async function ensureAdsReady(creds) {
  for (const url of plannerCandidates(['/aw/keywordplanner/ideas/new', '/aw/keywordplanner/ideas', '/aw/keywordplanner', '/aw/campaigns'])) {
    await nav(url);
    const current = await evalState(6000);
    if (/accounts\.google\.com/i.test(current.url || '')) {
      if (!await handleGoogleLogin(creds)) return false;
      await nav(url);
    }
    const after = await evalState(6000);
    if (/Google Ads 2-step verification required/i.test(after.text || '') && !/\/aw\/campaigns/i.test(url)) continue;
    if (/selectaccount/i.test(after.url || '') || /Select a Google Ads account|Select an active account|Google Ads account/i.test(after.text || '')) {
      if (await selectGoogleAdsAccount()) return true;
      continue;
    }
    if (/Keyword Planner|Discover new keywords|Get search volume|Campaigns|Create campaign/i.test(after.text || '')) {
      return await selectGoogleAdsAccount();
    }
  }
  return false;
}

async function openKeywordPlanner() {
  for (const url of plannerCandidates(['/aw/keywordplanner/ideas/new', '/aw/keywordplanner/ideas', '/aw/keywordplanner', '/aw/keywordplanner/home'])) {
    await nav(url);
    await selectGoogleAdsAccount();
    await dismissChrome();
    let s = await evalState(9000);
    for (let i = 0; i < 12 && !/Discover new keywords|Get search volume|forecasts?|Avg\.? monthly searches|Saved keywords|Enter or paste your keywords/i.test(s.text || ''); i += 1) {
      await idle('short');
      s = await evalState(9000);
    }
    if (/Discover new keywords|Get search volume|forecasts?|Avg\.? monthly searches|Saved keywords|Enter or paste your keywords/i.test(s.text || '')) {
      return { ok: true, path: url, url: s.url, textPreview: norm(s.text).slice(0, 1000) };
    }
  }
  if (await clickControl('Tools|Planning|Keyword Planner', 'Keyword Planner navigation').catch(() => false)) {
    await idle('deliberate');
    let s = await evalState(9000);
    for (let i = 0; i < 12 && !/Discover new keywords|Get search volume|forecasts?|Avg\.? monthly searches|Saved keywords/i.test(s.text || ''); i += 1) {
      await idle('short');
      s = await evalState(9000);
    }
    if (/Discover new keywords|Get search volume|forecasts?|Avg\.? monthly searches|Saved keywords/i.test(s.text || '')) {
      return { ok: true, path: 'menu', url: s.url, textPreview: norm(s.text).slice(0, 1000) };
    }
  }
  const s = await evalState(4000);
  return { ok: false, url: s.url, textPreview: norm(s.text).slice(0, 1200) };
}

async function keywordInputVisible() {
  const s = await evalState(7000);
  return s.inputs.some((input) => input.visible && /keyword|phrase|service|paste/i.test(`${input.aria} ${input.placeholder} ${input.tag}`) && !/website|domain|url/i.test(`${input.aria} ${input.placeholder}`));
}

async function chooseVolumeMode() {
  if (await keywordInputVisible()) return true;
  await dismissChrome();
  if (await clickControl('Add keywords', 'Add keywords', { minY: 120, maxY: 420, maxArea: 80_000 }).catch(() => false)) {
    await idle('deliberate');
    if (await keywordInputVisible()) return true;
  }
  if (await clickControl('Get search volume and forecasts|Get search volume|forecasts', 'Get search volume card', { minY: 100, maxY: 650, maxArea: 800_000 }).catch(() => false)) {
    await idle('deliberate');
  }
  return await keywordInputVisible();
}

async function submitKeywords() {
  await fillKeywordInput();
  await dismissChrome();
  return await clickControl('^Save$|Get started|Get results|See results|View results|^Search$', 'planner submit', { minY: 180, maxY: 760, maxArea: 80_000 }).catch(() => false);
}

function parseMoney(value) {
  const match = String(value || '').match(/(?:US)?\$\s?\d+(?:[,.]\d+)?/i);
  return match ? match[0].replace(/\s+/g, '') : null;
}

function parseRows(text) {
  const lines = String(text || '').split(/\r?\n/).map(norm).filter(Boolean);
  const rows = [];
  for (const keyword of keywords) {
    const wanted = keyword.toLowerCase();
    const index = lines.findIndex((line) => line.toLowerCase() === wanted || line.toLowerCase().includes(wanted));
    if (index < 0) continue;
    const window = lines.slice(index, index + 14);
    const monthly = window.find((line, i) => i > 0 && /^\d{1,3}(?:,\d{3})*(?:\.\d+)?$/.test(line));
    const changes = window.filter((line) => /^[-+]?\d+%$/.test(line));
    const competition = window.find((line) => /^(Low|Medium|High)$/i.test(line)) || null;
    const bids = window.map(parseMoney).filter(Boolean);
    rows.push({
      keyword: window[0] || keyword,
      avgMonthlySearches: monthly ? Number(monthly.replace(/,/g, '')) : null,
      avgMonthlySearchesText: monthly || null,
      threeMonthChange: changes[0] || null,
      yoyChange: changes[1] || null,
      competition,
      adImpressionShare: window.find((line) => /^<?\s?\d+(?:\.\d+)?%$/.test(line)) || null,
      topOfPageBidLow: bids[0] || null,
      topOfPageBidHigh: bids[1] || null,
      raw: window,
    });
  }
  return rows.filter((row) => row.avgMonthlySearchesText || row.competition || row.topOfPageBidLow);
}

async function waitForResults() {
  let last = null;
  for (let i = 0; i < 48; i += 1) {
    await idle('short');
    const s = await evalState(20_000);
    last = s;
    const rows = parseRows(s.text || '');
    if (rows.length) return { state: s, rows };
    if (/No keywords|No results|No account|Unable|error/i.test(s.text || '') && /Keyword Planner/i.test(s.text || '')) break;
  }
  return { state: last || await evalState(20_000), rows: [] };
}

function writeKeywordReport(result, steps) {
  const report = {
    ok: result.rows.length > 0,
    source: 'google_ads_keyword_planner_keeper_existing_window',
    session: SESSION,
    customer: cid,
    customerDashed: dashedCustomerId(cid),
    accountEmail: preferredEmail(),
    keywords,
    url: result.state?.url || '',
    title: result.state?.title || '',
    capturedAt: new Date().toISOString(),
    rows: result.rows,
    textPreview: norm(result.state?.text || '').slice(0, 3000),
    steps,
  };
  writeResult(report, report.ok ? 0 : 7);
}

async function main() {
  applyEnvDefaults(loadEnvFile('.env'));
  applyEnvDefaults(loadEnvFile('.env.local'));
  applyEnvDefaults(loadEnvFile('.env.production'));
  applyEnvDefaults(loadEnvFile(join(process.cwd(), '..', 'content-platform', '.env.local')));
  applyEnvDefaults(loadEnvFile(join(process.cwd(), '..', 'content-platform', '.env.production')));

  if (!socketReady()) writeResult({ ok: false, blocked: 'keeper_socket_not_ready', session: SESSION, socket: SOCK }, 3);
  const creds = await resolveSsoCreds();
  if (!creds?.password) writeResult({ ok: false, blocked: 'missing_google_sso_password', session: SESSION, email: preferredEmail() }, 4);
  if (creds.email && !process.env.GOOGLE_ADS_EMAIL && !process.env.SSO_EMAIL && !process.env.GM_EMAIL) {
    process.env.GOOGLE_ADS_EMAIL = creds.email;
  }
  const steps = [{ step: 'sso_creds_resolved', source: creds.source || 'unknown' }];

  if (!await ensureAdsReady(creds)) {
    const s = await evalState(6000).catch(() => ({}));
    writeResult({ ok: false, blocked: 'google_ads_login_not_ready', session: SESSION, url: s.url, textPreview: norm(s.text).slice(0, 1200) }, 4);
  }
  steps.push({ step: 'ads_ready', url: (await evalState(1000)).url });

  const open = await openKeywordPlanner();
  steps.push({ step: 'planner_open', open });
  if (!open.ok) writeResult({ ok: false, blocked: 'keyword_planner_not_opened', session: SESSION, customer: cid, keywords, open, steps }, 5);

  const already = await evalState(20_000);
  const alreadyRows = parseRows(already.text || '');
  if (alreadyRows.length) {
    steps.push({ step: 'existing_results_ready', keywords });
    writeKeywordReport({ state: already, rows: alreadyRows }, steps);
  }

  if (!await chooseVolumeMode()) {
    const s = await evalState(6000);
    writeResult({ ok: false, blocked: 'keyword_volume_mode_not_opened', session: SESSION, customer: cid, keywords, url: s.url, textPreview: norm(s.text).slice(0, 1200), steps }, 6);
  }
  steps.push({ step: 'volume_mode_ready', url: (await evalState(1000)).url });

  await submitKeywords();
  steps.push({ step: 'keywords_submitted', keywords });

  const result = await waitForResults();
  writeKeywordReport(result, steps);
}

main().catch((error) => {
  writeResult({ ok: false, blocked: 'google_ads_keyword_planner_keeper_error', error: String(error?.message || error), session: SESSION, customer: cid, keywords }, 1);
});
