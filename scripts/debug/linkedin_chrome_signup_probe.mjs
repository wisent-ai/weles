import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const CHROME_BIN = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME_BIN)) throw new Error(`Chrome binary missing: ${CHROME_BIN}`);
if (/Chrome for Testing/i.test(CHROME_BIN)) throw new Error(`Refusing Chrome for Testing baseline: ${CHROME_BIN}`);
const chromeVersion = execFileSync(CHROME_BIN, ['--version'], { encoding: 'utf8' }).trim();

function latestPreflightEndpoint() {
  try {
    const raw = JSON.parse(readFileSync(join(process.cwd(), 'recordings', 'linkedin_register', 'proxy_preflight.json'), 'utf8'));
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

function bodyMarkers(body) {
  return {
    login_form: /name="session_key"|id="username"|input type="email"/.test(body),
    signup_form: /name="email-address"|id="email-address"|join-form-submit/.test(body),
    hard_challenge: /challenge-dialog|Security verification|checkpoint\/challenge|challengeIframe|g-recaptcha|google\.com\/recaptcha\/enterprise\/anchor|li\.protechts\.net|px-cloud/i.test(body),
    challenge_terms: /checkpoint|challenge|captcha|recaptcha|security/i.test(body),
    data_is_bot_false: /data-is-bot="false"/.test(body),
    data_is_bot_true: /data-is-bot="true"/.test(body),
  };
}

const proxy = decodoProxy();
const outDir = join(process.cwd(), 'recordings', 'linkedin_register');
mkdirSync(outDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = join(outDir, `chrome_signup_probe_${ts}.json`);
const userDataDir = `/tmp/linkedin-chrome-signup-${Date.now()}`;

const records = {
  started_at: new Date().toISOString(),
  browser: 'stock_google_chrome',
  browser_binary: CHROME_BIN,
  browser_version: chromeVersion,
  target_url: 'https://www.linkedin.com/signup',
  proxy: { server: proxy.server, username_present: !!proxy.username, password_present: !!proxy.password },
  exit_ip: '',
  requests: [],
  page: null,
};

const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: CHROME_BIN,
  headless: false,
  viewport: { width: 1920, height: 1080 },
  proxy: { server: proxy.server, username: proxy.username, password: proxy.password },
  args: ['--no-first-run', '--no-default-browser-check', '--lang=en-US'],
});

try {
  const page = context.pages()[0] || await context.newPage();
  page.on('request', (req) => {
    try {
      if (req.url() !== records.target_url) return;
      records.requests.push({ phase: 'request', method: req.method(), url: req.url(), headers: req.headers() });
    } catch {}
  });
  page.on('response', async (res) => {
    try {
      if (res.url() !== records.target_url) return;
      let body = '';
      try { body = await res.text(); } catch {}
      records.requests.push({
        phase: 'response',
        status: res.status(),
        url: res.url(),
        headers: res.headers(),
        body_bytes: body.length,
        body_markers: bodyMarkers(body),
        body_prefix: body.slice(0, 500),
      });
    } catch {}
  });
  try {
    const ipRes = await context.request.get('https://api.ipify.org', { timeout: 10000 });
    if (ipRes.ok()) records.exit_ip = (await ipRes.text()).trim();
  } catch {}
  await page.goto(records.target_url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => {
    records.goto_error = String(e?.message ?? e).slice(0, 300);
  });
  await page.waitForTimeout(3000).catch(() => {});
  const holdMs = Number(process.env.CHROME_PROBE_HOLD_MS || 0);
  if (holdMs > 0) {
    console.log(`[chrome-signup-probe] holding browser open for ${holdMs}ms`);
    await page.waitForTimeout(holdMs).catch(() => {});
  }
  records.page = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    pageKey: document.querySelector('meta[name="pageKey"]')?.getAttribute('content') || '',
    inputs: [...document.querySelectorAll('input')].slice(0, 20).map((i) => ({
      name: i.getAttribute('name') || '',
      id: i.id || '',
      type: i.getAttribute('type') || '',
      visible: !!(i.offsetWidth || i.offsetHeight || i.getClientRects().length),
    })),
    iframes: [...document.querySelectorAll('iframe')].map((f) => ({
      title: f.getAttribute('title') || '',
      src: f.getAttribute('src') || '',
      className: f.getAttribute('class') || '',
    })),
    markers: {
      challengeDialog: !!document.querySelector('#challenge-dialog, .challenge-dialog'),
      securityVerificationText: /Security verification/i.test(document.body?.innerText || ''),
      joinSubmit: !!document.querySelector('#join-form-submit'),
      dataIsBot: document.querySelector('meta#config')?.getAttribute('data-is-bot') || '',
    },
  })).catch((e) => ({ error: String(e?.message ?? e).slice(0, 300) }));
} finally {
  records.completed_at = new Date().toISOString();
  writeFileSync(outPath, JSON.stringify(records, null, 2));
  await context.close().catch(() => {});
}

console.log(`[chrome-signup-probe] output=${outPath}`);
console.log(`[chrome-signup-probe] exit_ip_present=${!!records.exit_ip} request_events=${records.requests.length} hard_challenge=${records.requests.some(r => r.body_markers?.hard_challenge) || records.page?.markers?.challengeDialog}`);
