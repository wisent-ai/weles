import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { humanFill } from '../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../dist/human/mouse.js';
import { runId, runRecordingsDir } from '../../dist/session/run-recordings.js';

const CHROME_BIN = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME_BIN)) throw new Error(`Chrome binary missing: ${CHROME_BIN}`);
if (/Chrome for Testing/i.test(CHROME_BIN)) throw new Error(`Refusing Chrome for Testing baseline: ${CHROME_BIN}`);

const OUT_DIR = runRecordingsDir('real_chrome', 'linkedin_register_probe');
mkdirSync(OUT_DIR, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = join(OUT_DIR, `real_chrome_register_probe_${ts}.json`);
const TARGET_URL = 'https://www.linkedin.com/signup';

function latestPreflightEndpoint() {
  try {
    const raw = JSON.parse(readFileSync(join(OUT_DIR, 'proxy_preflight.json'), 'utf8'));
    const endpoint = raw?.selected_endpoint ?? raw?.attempts?.find((a) => a?.endpoint)?.endpoint;
    if (endpoint?.host && endpoint?.port) return endpoint;
  } catch {}
  return null;
}

function decodoProxy() {
  const endpoint = latestPreflightEndpoint();
  const host = process.env.CHROME_PROBE_PROXY_HOST || endpoint?.host || process.env.DECODO_ISP_HOST || '185.111.111.44';
  const port = process.env.CHROME_PROBE_PROXY_PORT || endpoint?.port || process.env.DECODO_ISP_PORT || (process.env.DECODO_ISP_PORTS || '').split(',').map(s => s.trim()).filter(Boolean)[0] || '10001';
  const username = process.env.DECODO_ISP_USERNAME || '';
  const password = process.env.DECODO_ISP_PASSWORD || '';
  if (!username || !password) throw new Error('DECODO_ISP_USERNAME/DECODO_ISP_PASSWORD missing');
  return { server: `http://${host}:${port}`, username, password, host, port };
}

function genIdentity() {
  const firstNames = 'Kenyon,Marlon,Rowan,Dorian,Reese,Auden,Quinn,Logan,Sage,Taylor'.split(',');
  const lastNames = 'Rosenbaum,Koepp,Bayer,Pratt,Quinn,Reeves,Stone,Vega,West,Cole'.split(',');
  const first = firstNames[Math.floor(Math.random() * firstNames.length)];
  const last = lastNames[Math.floor(Math.random() * lastNames.length)];
  const handle = `${first.toLowerCase()}${last.toLowerCase()}${Math.floor(Math.random() * 9000 + 1000)}`;
  const domain = process.env.LINKEDIN_PROBE_EMAIL_DOMAIN || 'inboxmail659.com';
  const password = `${randomBytes(8).toString('base64').replace(/[+/=]/g, '')}!A1`;
  return { first, last, email: `${handle}@${domain}`, password };
}

function redactText(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<redacted-email>')
    .replace(/("(?:password|emailAddress|email|firstName|lastName)"\s*:\s*)"[^"]*"/gi, '$1"<redacted>"');
}

function safeHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = /cookie|authorization|proxy-authorization/i.test(k) ? '<redacted>' : v;
  }
  return out;
}

function bodyMarkers(body) {
  return {
    signup_form: /name="email-address"|id="email-address"|join-form-submit/.test(body),
    challenge_dialog_template: /challenge-dialog/.test(body),
    checkpoint: /checkpoint\/challenge|challengeIframe/i.test(body),
    recaptcha: /google\.com\/recaptcha|g-recaptcha/i.test(body),
    protechts: /li\.protechts\.net|client\.protechts\.net/i.test(body),
    data_is_bot_false: /data-is-bot="false"/.test(body),
    data_is_bot_true: /data-is-bot="true"/.test(body),
  };
}

const proxy = decodoProxy();
const identity = genIdentity();
const userDataDir = mkdtempSync(join(tmpdir(), 'linkedin-real-chrome-register-'));
const chromeVersion = execFileSync(CHROME_BIN, ['--version'], { encoding: 'utf8' }).trim();

const records = {
  started_at: new Date().toISOString(),
  browser: 'real_google_chrome_playwright_controlled',
  browser_binary: CHROME_BIN,
  browser_version: chromeVersion,
  run_id: runId(),
  action: process.env.ACTION || null,
  target_url: TARGET_URL,
  proxy: { server: proxy.server, username_present: !!proxy.username, password_present: !!proxy.password },
  identity: { email_present: true, password_present: true, first: identity.first, last: identity.last },
  console: [],
  pageerrors: [],
  requests: [],
  cdp_network: [],
  stdout: [],
};

function log(line) {
  records.stdout.push({ t: Date.now(), line });
  console.log(`[real-chrome-register-probe] ${line}`);
}

const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: CHROME_BIN,
  headless: false,
  viewport: { width: 1680, height: 1050 },
  deviceScaleFactor: 2,
  locale: 'en-US',
  timezoneId: 'America/New_York',
  recordVideo: { dir: OUT_DIR, size: { width: 1280, height: 720 } },
  proxy: { server: proxy.server, username: proxy.username, password: proxy.password },
  args: ['--no-first-run', '--no-default-browser-check', '--lang=en-US'],
  ignoreDefaultArgs: ['--enable-automation'],
});

try {
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(45_000);

  const cdp = await context.newCDPSession(page).catch(() => null);
  if (cdp) {
    await cdp.send('Network.enable').catch(() => {});
    for (const event of ['requestWillBeSent', 'requestWillBeSentExtraInfo', 'responseReceived', 'responseReceivedExtraInfo', 'loadingFailed']) {
      cdp.on(`Network.${event}`, (payload) => {
        const url = payload?.request?.url || payload?.response?.url || '';
        const path = payload?.headers?.[':path'] || '';
        if (!/linkedin|protechts|google|doubleclick|recaptcha/.test(url + path)) return;
        records.cdp_network.push({
          t: Date.now(),
          event,
          requestId: payload.requestId,
          type: payload.type,
          url,
          headers: safeHeaders(payload.headers || payload.request?.headers || payload.response?.headers || {}),
          method: payload.request?.method,
          postData: redactText(payload.request?.postData || ''),
          status: payload.response?.status ?? payload.statusCode,
          errorText: payload.errorText,
          canceled: payload.canceled,
          blockedCookies: payload.blockedCookies,
        });
      });
    }
  }

  page.on('console', (msg) => {
    records.console.push({
      t: Date.now(),
      type: msg.type(),
      text: redactText(msg.text()).slice(0, 4000),
      location: msg.location(),
    });
  });
  page.on('pageerror', (err) => {
    records.pageerrors.push({
      t: Date.now(),
      name: err.name,
      message: redactText(err.message).slice(0, 2000),
      stack: redactText(err.stack || '').slice(0, 4000),
    });
  });
  page.on('request', (req) => {
    const url = req.url();
    if (!/linkedin|protechts|google|doubleclick|recaptcha/.test(url)) return;
    records.requests.push({
      t: Date.now(),
      phase: 'request',
      method: req.method(),
      url,
      resource_type: req.resourceType(),
      headers: safeHeaders(req.headers()),
      post_data: redactText(req.postData() || '').slice(0, 4000),
    });
  });
  page.on('response', async (res) => {
    const url = res.url();
    if (!/linkedin|protechts|google|doubleclick|recaptcha/.test(url)) return;
    let body = '';
    if (/linkedin\.com\/signup|createAccount|verifyPassword|protechts\.net/.test(url)) {
      try { body = await res.text(); } catch {}
    }
    records.requests.push({
      t: Date.now(),
      phase: 'response',
      status: res.status(),
      url,
      headers: safeHeaders(res.headers()),
      body_bytes: body.length,
      body_markers: body ? bodyMarkers(body) : undefined,
      body_text_redacted: redactText(body).slice(0, 3000),
    });
  });

  try {
    const ipRes = await context.request.get('https://api.ipify.org', { timeout: 10_000 });
    if (ipRes.ok()) records.exit_ip = (await ipRes.text()).trim();
  } catch {}

  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await humanIdlePause('deliberate');
  log(`signup loaded url=${page.url()}`);

  await humanFill(page, page.locator('input[name="email-address"], input#email-address, input[type="email"]').first(), identity.email);
  await humanIdlePause('short');
  await humanFill(page, page.locator('input[name="password"], input#password, input[type="password"]').first(), identity.password);
  await humanIdlePause('deliberate');
  log('filled email+password');

  const verifyPasswordResP = page.waitForResponse((r) => /\/signup\/api\/verifyPassword/.test(r.url()), { timeout: 20_000 }).catch(() => null);
  await humanClickLocator(page, page.locator('button:has-text("Agree & Join"), button[type="submit"], button#join-form-submit').first());
  const verifyPasswordRes = await verifyPasswordResP;
  log(`verifyPassword status=${verifyPasswordRes?.status?.() ?? 'none'}`);
  await humanIdlePause('long');

  const firstLoc = page.locator('input[name="first-name"], input#first-name').filter({ visible: true }).first();
  const lastLoc = page.locator('input[name="last-name"], input#last-name').filter({ visible: true }).first();
  const hasFirst = await firstLoc.count().catch(() => 0);
  const hasLast = await lastLoc.count().catch(() => 0);
  log(`name fields visible first=${hasFirst} last=${hasLast}`);
  if (hasFirst && hasLast) {
    await humanFill(page, firstLoc, identity.first);
    await humanIdlePause('short');
    await humanFill(page, lastLoc, identity.last);
    await humanIdlePause('deliberate');
    const createAccountResP = page.waitForResponse((r) => /\/signup\/api\/cors\/createAccount/.test(r.url()), { timeout: 20_000 }).catch(() => null);
    await humanClickLocator(page, page.locator('button:has-text("Continue"), button[type="submit"], button#join-form-submit').first());
    const createAccountRes = await createAccountResP;
    let createBody = '';
    if (createAccountRes) {
      try { createBody = await createAccountRes.text(); } catch {}
    }
    records.createAccount = {
      status: createAccountRes?.status?.() ?? null,
      url: createAccountRes?.url?.() ?? null,
      body_redacted: redactText(createBody).slice(0, 3000),
      challengeUrl: (() => { try { return JSON.parse(createBody)?.challengeUrl || ''; } catch { return ''; } })(),
    };
    log(`createAccount status=${records.createAccount.status ?? 'none'} challengeUrl=${records.createAccount.challengeUrl ? 'present' : 'none'}`);
  }

  await humanIdlePause('deliberate');
  records.page = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    pageKey: document.querySelector('meta[name="pageKey"]')?.getAttribute('content') || '',
    dataIsBot: document.querySelector('meta#config')?.getAttribute('data-is-bot') || '',
    challengeDialog: !!document.querySelector('#challenge-dialog, .challenge-dialog'),
    securityText: /Security verification|quick security check/i.test(document.body?.innerText || ''),
    iframes: [...document.querySelectorAll('iframe')].map((f) => ({
      title: f.getAttribute('title') || '',
      src: f.getAttribute('src') || '',
      className: f.getAttribute('class') || '',
      visible: !!(f.offsetWidth || f.offsetHeight || f.getClientRects().length),
    })).slice(0, 40),
  })).catch((e) => ({ error: String(e?.message ?? e).slice(0, 300) }));
} finally {
  records.completed_at = new Date().toISOString();
  writeFileSync(outPath, JSON.stringify(records, null, 2));
  await context.close().catch(() => {});
}

console.log(`[real-chrome-register-probe] output=${outPath}`);
console.log(`[real-chrome-register-probe] createAccountChallenge=${!!records.createAccount?.challengeUrl} consoleEvalError=${records.console.some(c => /EvalError/.test(c.text || ''))}`);
