import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { humanFill } from '../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../dist/human/mouse.js';
import { CaptchaSolver } from '../../dist/captcha/solver.js';
import { solveRecaptchaV2 as solveRecaptchaV2InPage } from '../../dist/captcha/recaptcha.js';
import { getCaptchaCredentials } from '../../dist/utils/credentials.js';

const CHROME_BIN = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME_BIN)) throw new Error(`Chrome binary missing: ${CHROME_BIN}`);
if (/Chrome for Testing/i.test(CHROME_BIN)) throw new Error(`Refusing Chrome for Testing baseline: ${CHROME_BIN}`);

const OUT_DIR = join(process.cwd(), 'recordings', 'linkedin_register');
mkdirSync(OUT_DIR, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = join(OUT_DIR, `linkedin_challenge_solve_probe_${ts}.json`);

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
  if (!username || !password) throw new Error('proxy username/password missing');
  return { server: `http://${host}:${port}`, username, password, host, port };
}

function genIdentity() {
  const firstNames = 'Kenyon,Marlon,Rowan,Dorian,Reese,Auden,Quinn,Logan,Sage,Taylor'.split(',');
  const lastNames = 'Rosenbaum,Koepp,Bayer,Pratt,Quinn,Reeves,Stone,Vega,West,Cole'.split(',');
  const first = firstNames[Math.floor(Math.random() * firstNames.length)];
  const last = lastNames[Math.floor(Math.random() * lastNames.length)];
  const handle = `${first.toLowerCase()}${last.toLowerCase()}${Math.floor(Math.random() * 9000 + 1000)}`;
  const domain = process.env.LINKEDIN_PROBE_EMAIL_DOMAIN || 'pilatesguild.com';
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
    out[k] = /cookie|authorization|proxy-authorization/i.test(k) ? '<redacted>' : redactText(String(v)).slice(0, 1000);
  }
  return out;
}

function safePostDataSummary(postData = '') {
  if (!postData) return null;
  const out = { length: postData.length, fields: [] };
  try {
    const params = new URLSearchParams(postData);
    out.fields = Array.from(params.entries()).map(([name, value]) => ({
      name,
      value_len: value.length,
      value_preview: /token|password|email|name/i.test(name) ? '<redacted>' : redactText(value).slice(0, 120),
    }));
  } catch {
    out.preview = redactText(postData).slice(0, 500);
  }
  return out;
}

async function captchaApiSolve(apiUrl, clientKey, task) {
  const svc = apiUrl.replace('https://api.', '').replace('.com', '');
  console.log(`[linkedin-challenge-solve-probe] ${svc} createTask type=${task.type} proxy=${!!task.proxyAddress}`);
  const createRes = await (await fetch(`${apiUrl}/createTask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientKey, task }),
  })).json();
  if (createRes.errorId) {
    console.log(`[linkedin-challenge-solve-probe] ${svc} createTask error ${createRes.errorCode}: ${createRes.errorDescription}`);
    return null;
  }
  const taskId = createRes.taskId;
  if (!taskId) return null;
  console.log(`[linkedin-challenge-solve-probe] ${svc} taskId=${taskId}`);
  for (let i = 0; i < 60; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const res = await (await fetch(`${apiUrl}/getTaskResult`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey, taskId }),
    })).json();
    if (res.status === 'ready') return res.solution?.gRecaptchaResponse ?? res.solution?.token ?? null;
    if (res.errorId) {
      console.log(`[linkedin-challenge-solve-probe] ${svc} result error ${res.errorCode}: ${res.errorDescription}`);
      return null;
    }
  }
  return null;
}

async function solveRecaptchaV2EnterpriseWithProxy(page, sitekey, proxy, websiteURL) {
  const creds = await getCaptchaCredentials();
  const ua = await page.evaluate(() => navigator.userAgent).catch(() => '');
  const proxyUrl = new URL(proxy.server);
  const baseTask = {
    type: 'RecaptchaV2EnterpriseTask',
    websiteURL: websiteURL || page.url(),
    websiteKey: sitekey,
    proxyType: proxyUrl.protocol.replace(':', '') || 'http',
    proxyAddress: proxyUrl.hostname,
    proxyPort: Number(proxyUrl.port),
    proxyLogin: proxy.username,
    proxyPassword: proxy.password,
    userAgent: ua,
  };
  if (creds.capmonster) {
    const t = await captchaApiSolve('https://api.capmonster.cloud', creds.capmonster, baseTask);
    if (t) return { token: t, service: 'capmonster', task_type: baseTask.type, proxy: true, user_agent_len: ua.length };
  }
  if (creds.capsolver) {
    const t = await captchaApiSolve('https://api.capsolver.com', creds.capsolver, { ...baseTask, type: 'ReCaptchaV2EnterpriseTask' });
    if (t) return { token: t, service: 'capsolver', task_type: 'ReCaptchaV2EnterpriseTask', proxy: true, user_agent_len: ua.length };
  }
  if (creds.anticaptcha) {
    const t = await captchaApiSolve('https://api.anti-captcha.com', creds.anticaptcha, baseTask);
    if (t) return { token: t, service: 'anticaptcha', task_type: baseTask.type, proxy: true, user_agent_len: ua.length };
  }
  return null;
}

async function frameSummary(page) {
  const frames = page.frames();
  const out = [];
  for (const frame of frames) {
    const url = frame.url();
    if (!/linkedin|recaptcha|protechts|google/.test(url)) continue;
    const info = await frame.evaluate(() => {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      return {
        title: document.title,
        text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
        forms: Array.from(document.querySelectorAll('form')).map((form) => ({
          action: form.getAttribute('action') || '',
          method: form.getAttribute('method') || '',
          text: (form.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500),
        })),
        buttons: Array.from(document.querySelectorAll('button,input[type="submit"],a')).map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || '',
          text: (el.innerText || el.value || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
          href: el.getAttribute('href') || '',
          visible: vis(el),
        })).slice(0, 40),
        inputs: Array.from(document.querySelectorAll('input,textarea')).map((el) => ({
          tag: el.tagName.toLowerCase(),
          name: el.getAttribute('name') || '',
          id: el.getAttribute('id') || '',
          type: el.getAttribute('type') || '',
          value_len: (el.value || '').length,
          visible: vis(el),
        })).slice(0, 80),
        scripts: Array.from(document.scripts).map((s) => s.src || s.textContent?.slice(0, 200) || '').filter(Boolean).slice(0, 40),
        recaptcha_clients: Object.keys(window.___grecaptcha_cfg?.clients || {}).slice(0, 20),
      };
    }).catch((e) => ({ error: String(e?.message ?? e).slice(0, 300) }));
    out.push({ url, ...info });
  }
  return out;
}

async function findEnterpriseRecaptcha(page) {
  for (const frame of page.frames()) {
    if (!/\/checkpoint\/challenge/i.test(frame.url())) continue;
    const formKey = await frame.locator('input[name="captchaSiteKey"]').first().inputValue({ timeout: 1000 }).catch(() => '');
    if (formKey) return { sitekey: formKey, frame_url: frame.url(), enterprise: true, source: 'checkpoint_form' };
  }
  const candidates = [];
  for (const frame of page.frames()) {
    const url = frame.url();
    if (!/recaptcha/.test(url)) continue;
    try {
      const u = new URL(url);
      const k = u.searchParams.get('k');
      if (k) candidates.push({
        sitekey: k,
        frame_url: url,
        enterprise: /\/enterprise\//.test(u.pathname),
        size: u.searchParams.get('size') || '',
        source: 'recaptcha_frame',
      });
    } catch {}
  }
  return candidates.find((c) => c.size === 'normal') ?? candidates[0] ?? null;
}

async function injectRecaptchaToken(page, token) {
  const challengeFrame = page.frames().find((frame) => /\/checkpoint\/challenge(\/verify|Iframe)?/i.test(frame.url()));
  if (!challengeFrame) return { error: 'checkpoint frame not found' };
  return await challengeFrame.evaluate((t) => {
    let touched = 0;
    let submitted = 0;
    let clicked = 0;
    const fieldLengths = {};
    const ensureFields = (doc) => {
      let ta = doc.querySelector('textarea#g-recaptcha-response, textarea[name="g-recaptcha-response"]');
      if (!ta) {
        ta = doc.createElement('textarea');
        ta.id = 'g-recaptcha-response';
        ta.name = 'g-recaptcha-response';
        ta.style.display = 'none';
        doc.body.appendChild(ta);
      }
      ta.value = t;
      ta.textContent = t;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      touched++;
      for (const el of Array.from(doc.querySelectorAll('input[name="captchaUserResponseToken"], input[name*="captcha" i], textarea[name*="captcha" i], textarea[name="g-recaptcha-response"]'))) {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          if (/sitekey/i.test(el.name)) continue;
          if (/captchaUserResponseToken|response/i.test(el.name) || !el.value) {
            el.value = t;
            el.textContent = t;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            touched++;
          }
        }
      }
      for (const el of Array.from(doc.querySelectorAll('input,textarea'))) {
        const name = el.getAttribute('name') || el.getAttribute('id') || '';
        if (/captcha|recaptcha|response/i.test(name)) fieldLengths[name] = (el.value || '').length;
      }
    };
    const submitForms = (doc) => {
      const docUrl = String(doc.location?.href || '');
      for (const form of Array.from(doc.querySelectorAll('form'))) {
        try {
          const action = String(form.getAttribute('action') || form.action || '');
          if (!/\/checkpoint\/challenge/i.test(docUrl + ' ' + action)) continue;
          if (typeof form.requestSubmit === 'function') form.requestSubmit();
          else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          submitted++;
        } catch {}
      }
      if (!/\/checkpoint\/challenge/i.test(docUrl)) return;
      for (const btn of Array.from(doc.querySelectorAll('button,input[type="submit"]'))) {
        const text = (btn.innerText || btn.value || '').trim();
        if (/submit|continue|verify|i.?m not a robot/i.test(text) || btn.type === 'submit') {
          try { btn.click(); clicked++; } catch {}
        }
      }
    };
    const walk = (doc, depth = 0) => {
      if (!doc || depth > 4) return;
      try {
        ensureFields(doc);
        for (const f of Array.from(doc.querySelectorAll('iframe'))) {
          try {
            if (f.contentDocument) walk(f.contentDocument, depth + 1);
          } catch {}
        }
        submitForms(doc);
      } catch {}
    };
    walk(document);
    return { frame_url: location.href, touched, submitted, clicked, field_lengths: fieldLengths };
  }, token).catch((e) => ({ error: String(e?.message ?? e).slice(0, 300) }));
}

const proxy = decodoProxy();
const identity = genIdentity();
const userDataDir = process.env.LINKEDIN_PROBE_USER_DATA_DIR || mkdtempSync(join(tmpdir(), 'linkedin-challenge-solve-probe-'));
const chromeVersion = execFileSync(CHROME_BIN, ['--version'], { encoding: 'utf8' }).trim();
const records = {
  started_at: new Date().toISOString(),
  browser: 'real_google_chrome_playwright_controlled',
  browser_version: chromeVersion,
  proxy: { server: proxy.server, username_present: !!proxy.username, password_present: !!proxy.password },
  stdout: [],
  requests: [],
  console: [],
  solver: {},
};

function log(line) {
  records.stdout.push({ t: Date.now(), line });
  console.log(`[linkedin-challenge-solve-probe] ${line}`);
}

const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: CHROME_BIN,
  headless: false,
  viewport: { width: 1680, height: 1050 },
  deviceScaleFactor: 2,
  locale: 'en-US',
  timezoneId: 'America/New_York',
  proxy: { server: proxy.server, username: proxy.username, password: proxy.password },
  args: ['--no-first-run', '--no-default-browser-check', '--lang=en-US'],
  ignoreDefaultArgs: ['--enable-automation'],
});

try {
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(45_000);
  page.on('console', (msg) => records.console.push({ t: Date.now(), type: msg.type(), text: redactText(msg.text()).slice(0, 2000), location: msg.location() }));
  page.on('request', (req) => {
    const url = req.url();
    if (!/linkedin|protechts|google|recaptcha/.test(url)) return;
    const postData = req.postData() || '';
    records.requests.push({
      t: Date.now(),
      phase: 'request',
      method: req.method(),
      url,
      resource_type: req.resourceType(),
      headers: safeHeaders(req.headers()),
      post_data_len: postData.length,
      post_data_summary: /\/checkpoint\/challenge\/verify/i.test(url) ? safePostDataSummary(postData) : undefined,
    });
  });
  page.on('response', async (res) => {
    const url = res.url();
    if (!/linkedin|protechts|google|recaptcha/.test(url)) return;
    let body = '';
    if (/createAccount|challengeIframe|captchaInternal|verifyPassword/.test(url)) {
      try { body = await res.text(); } catch {}
    }
    records.requests.push({ t: Date.now(), phase: 'response', status: res.status(), url, headers: safeHeaders(res.headers()), body_len: body.length, body_text_redacted: redactText(body).slice(0, 3000) });
  });
  const ipRes = await context.request.get('https://api.ipify.org', { timeout: 10_000 }).catch(() => null);
  records.exit_ip = ipRes?.ok?.() ? (await ipRes.text()).trim() : null;

  if (process.env.LINKEDIN_PROBE_ENTRY_PATH === 'linkedin_home') {
    await page.goto('https://www.linkedin.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await humanIdlePause('deliberate');
    const joinLink = page.locator('a:has-text("Join now"), a:has-text("Join"), a[href*="/signup"]').filter({ visible: true }).first();
    if (await joinLink.count().catch(() => 0)) await humanClickLocator(page, joinLink);
    else await page.goto('https://www.linkedin.com/signup', { waitUntil: 'domcontentloaded', timeout: 45_000, referer: 'https://www.linkedin.com/' });
  } else {
    await page.goto('https://www.linkedin.com/signup', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  }
  await page.waitForURL(/\/signup/, { timeout: 15_000 }).catch(() => {});
  await humanIdlePause('deliberate');
  await humanFill(page, page.locator('input[name="email-address"], input#email-address, input[type="email"]').first(), identity.email);
  await humanFill(page, page.locator('input[name="password"], input#password, input[type="password"]').first(), identity.password);
  const verifyPasswordResP = page.waitForResponse((r) => /\/signup\/api\/verifyPassword/.test(r.url()), { timeout: 20_000 }).catch(() => null);
  await humanClickLocator(page, page.locator('button:has-text("Agree & Join"), button[type="submit"], button#join-form-submit').first());
  log(`verifyPassword status=${(await verifyPasswordResP)?.status?.() ?? 'none'}`);
  await humanIdlePause('long');
  const firstLoc = page.locator('input[name="first-name"], input#first-name').filter({ visible: true }).first();
  const lastLoc = page.locator('input[name="last-name"], input#last-name').filter({ visible: true }).first();
  await humanFill(page, firstLoc, identity.first);
  await humanFill(page, lastLoc, identity.last);
  const createAccountResP = page.waitForResponse((r) => /\/signup\/api\/cors\/createAccount/.test(r.url()), { timeout: 20_000 }).catch(() => null);
  await humanClickLocator(page, page.locator('button:has-text("Continue"), button[type="submit"], button#join-form-submit').first());
  const createAccountRes = await createAccountResP;
  const createBody = createAccountRes ? await createAccountRes.text().catch(() => '') : '';
  const challengeUrl = (() => { try { return JSON.parse(createBody)?.challengeUrl || ''; } catch { return ''; } })();
  records.createAccount = { status: createAccountRes?.status?.() ?? null, challengeUrl };
  log(`createAccount status=${records.createAccount.status ?? 'none'} challenge=${!!challengeUrl}`);
  if (challengeUrl) {
    await page.waitForURL(/\/signup/, { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(8000);
    records.before_solve_frames = await frameSummary(page);
    const recaptcha = await findEnterpriseRecaptcha(page);
    records.solver.recaptcha = recaptcha;
    log(`recaptcha sitekey=${recaptcha?.sitekey?.slice(0, 12) ?? 'none'} enterprise=${recaptcha?.enterprise ?? false}`);
    if (process.env.LINKEDIN_CHALLENGE_TRY_SOLVE === '1' && recaptcha?.sitekey) {
      if (process.env.LINKEDIN_CHALLENGE_SOLVER_VISUAL === '1') {
        const solvedVisual = await solveRecaptchaV2InPage(page).catch((e) => {
          console.log(`[linkedin-challenge-solve-probe] visual solver error: ${e.message?.slice(0, 120)}`);
          return false;
        });
        records.solver.visual_solver = { result: solvedVisual };
        await humanIdlePause('long');
        if (solvedVisual) {
          const retryCreateP = page.waitForResponse((r) => /\/signup\/api\/cors\/createAccount/.test(r.url()), { timeout: 20_000 }).catch(() => null);
          const retryBtn = page.locator('button:has-text("Continue"), button[type="submit"], button#join-form-submit').filter({ visible: true }).first();
          if (await retryBtn.count().catch(() => 0)) {
            await humanClickLocator(page, retryBtn);
            const retryRes = await retryCreateP;
            const retryBody = retryRes ? await retryRes.text().catch(() => '') : '';
            records.post_visual_createAccount = {
              status: retryRes?.status?.() ?? null,
              body_redacted: redactText(retryBody).slice(0, 1000),
              challengeUrl: (() => { try { return JSON.parse(retryBody)?.challengeUrl || ''; } catch { return ''; } })(),
            };
            await humanIdlePause('long');
          }
        }
        records.after_solve_frames = await frameSummary(page);
        records.after_solve_page = { url: page.url(), title: await page.title().catch(() => '') };
      } else {
      let solved = null;
      if (process.env.LINKEDIN_CHALLENGE_SOLVER_PROXY === '1') {
        solved = await solveRecaptchaV2EnterpriseWithProxy(page, recaptcha.sitekey, proxy, recaptcha.frame_url);
        records.solver.proxy_solver = solved ? { ...solved, token: '<redacted>' } : null;
      }
      const solver = solved ? null : new CaptchaSolver();
      const token = solved?.token ?? await solver.solveRecaptchaV2(page, recaptcha.sitekey, { enterprise: recaptcha.enterprise });
      records.solver.token_received = typeof token === 'string';
      if (typeof token === 'string') {
        records.solver.inject_result = await injectRecaptchaToken(page, token);
        await humanIdlePause('long');
        records.after_solve_frames = await frameSummary(page);
        records.after_solve_page = { url: page.url(), title: await page.title().catch(() => '') };
      }
      }
    }
  }
} finally {
  records.completed_at = new Date().toISOString();
  writeFileSync(outPath, JSON.stringify(records, null, 2));
  await context.close().catch(() => {});
}

console.log(`[linkedin-challenge-solve-probe] output=${outPath}`);
console.log(`[linkedin-challenge-solve-probe] challenge=${!!records.createAccount?.challengeUrl} token=${records.solver?.token_received === true}`);
