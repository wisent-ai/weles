// Scrape unusualwhales.com ticker data using cached session cookies.
// Usage: node scripts/trajectories/unusualwhales/scrape.mjs --ticker ORCL --page overview
//   pages: overview | flow | darkpool | gex
//   optional: --screenshot /path/to/out.png
// Outputs JSON to stdout on success, non-zero exit on failure.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

// Redirect all console.log to stderr so stdout is pure JSON output.
// Must happen before importing WSession which logs on import.
console.log = (...a) => process.stderr.write(a.map(String).join(' ') + '\n');

const { WSession } = await import('../../../dist/session/wsession.js');
const { loadEnv } = await import('./_envload.mjs');

loadEnv();

// Parse args
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}
const ticker = (args.ticker || '').toUpperCase();
const page = args.page || 'overview';
const screenshotPath = args.screenshot;
if (!ticker) {
  console.error('FAIL: --ticker required');
  process.exit(1);
}

const PAGE_URLS = {
  overview: (t) => `https://unusualwhales.com/stock/${t}/overview`,
  flow: (t) => `https://unusualwhales.com/stock/${t}/flow-overview`,
  darkpool: (t) => `https://unusualwhales.com/stock/${t}/dark-pool`,
  gex: (t) => `https://unusualwhales.com/stock/${t}/greek-exposure`,
};
if (!PAGE_URLS[page]) {
  console.error(`FAIL: unknown page '${page}', must be one of: ${Object.keys(PAGE_URLS).join(', ')}`);
  process.exit(1);
}

const COOKIE_PATH = path.join(os.homedir(), '.weles', 'uw_cookies.json');
if (!fs.existsSync(COOKIE_PATH)) {
  console.error(`FAIL: no cached cookies at ${COOKIE_PATH}. Run login.mjs first.`);
  process.exit(1);
}
const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8'));

const proxyUrl = process.env.PROXY_URL || 'residential';
const s = await WSession.start({ label: `uw_scrape_${ticker}`, proxy: proxyUrl });

async function runLogin() {
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const loginScript = path.join(scriptDir, 'login.mjs');
  console.error(`[uw_scrape] cookies invalid, running login.mjs`);
  const result = spawnSync('node', [loginScript], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('FAIL: re-login failed');
    process.exit(1);
  }
}

try {
  await s.ctx.addCookies(cookies);
  const url = PAGE_URLS[page](ticker);
  console.error(`[uw_scrape] navigating to ${url}`);
  await s.goto(url);

  // Detect redirect to login — cookies expired
  let currentUrl = s.page.url();
  if (currentUrl.includes('/login')) {
    await s.close().catch(() => {});
    await runLogin();
    // Re-launch with fresh cookies
    const s2 = await WSession.start({ label: `uw_scrape_${ticker}_retry`, proxy: proxyUrl });
    const fresh = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8'));
    await s2.ctx.addCookies(fresh);
    await s2.goto(url);
    currentUrl = s2.page.url();
    if (currentUrl.includes('/login')) {
      console.error('FAIL: still redirected to login after re-auth');
      process.exit(1);
    }
    // swap session
    global._s = s2;
  } else {
    global._s = s;
  }
  const sess = global._s;

  // Wait for page content to render (up to 60s)
  let ready = false;
  let lastLen = 0;
  for (let i = 0; i < 60; i++) {
    const len = await sess.page.evaluate('document.body?.innerText?.length || 0').catch(() => 0);
    if (len > 500) { ready = true; console.error(`[uw_scrape] page rendered after ${i + 1}s (bodyText=${len} chars)`); break; }
    if (i % 5 === 0) console.error(`[uw_scrape] waiting for render... bodyText=${len}`);
    lastLen = len;
    await sess.wait(1);
  }
  if (!ready) {
    const url = sess.page.url();
    console.error(`FAIL: page never rendered. url=${url} lastLen=${lastLen}`);
    await sess.page.screenshot({ path: '/tmp/uw_scrape_fail.png' }).catch(() => {});
    process.exit(1);
  }
  // Let charts/tables settle
  await sess.wait(5);

  // Optional screenshot
  if (screenshotPath) {
    await sess.page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    console.error(`[uw_scrape] screenshot saved to ${screenshotPath}`);
  }

  // Generic extraction: grab page title, all tables as arrays of rows, top-level text blocks
  const data = await sess.page.evaluate(`(() => {
    const out = { url: location.href, title: document.title };
    // Extract tables
    out.tables = Array.from(document.querySelectorAll('table')).slice(0, 10).map(t => {
      const headers = Array.from(t.querySelectorAll('thead th, thead td')).map(h => h.innerText.trim());
      const rows = Array.from(t.querySelectorAll('tbody tr')).slice(0, 50).map(r =>
        Array.from(r.querySelectorAll('td, th')).map(c => c.innerText.trim())
      );
      return { headers, rows };
    });
    // Extract visible text (truncated)
    out.bodyText = (document.body?.innerText || '').slice(0, 10000);
    return out;
  })()`);

  // Write JSON directly to real stdout (console.log is redirected).
  process.stdout.write(JSON.stringify({ ticker, page, ...data }) + '\n');
  process.exit(0);
} catch (e) {
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
} finally {
  await (global._s || s).close().catch(() => {});
}
