// retry-allowed: each paper queries Google Scholar through a residential
// proxy; the previous run died on the very first nav with net::ERR_ABORTED
// (proxy handshake race) and cascaded for all 10 papers because the
// browser context was torn down. Per-paper retry + session rebuild on a
// dead context is the structural recovery this trajectory needs.
//
// Fetch Google Scholar "Cited by N" counts for a list of arXiv IDs (or
// free-text queries) using the weles-patched Chromium + residential proxy +
// existing solvePageCaptcha primitive. Output is TSV on stdout:
//   <key>\t<citations>\t<title>
//
// Usage:
//   node weles/src/trajectories/google/scholar/citations.mjs \
//     2312.06681 2310.01405 ...
//
// Env:
//   PROXY_URL       residential|isp|<full proxy url>   (default residential)
//   SCHOLAR_DELAY_S delay seconds between queries     (default 6)
//   SCHOLAR_MAX_NAV_RETRIES   retries per paper       (default 3)
//   SCHOLAR_MAX_SESSION_REBUILDS retries that recreate WSession (default 2)

import { WSession } from '../../../../dist/session/wsession.js';
import { solvePageCaptcha } from '../../../../dist/captcha/detect.js';
import { CaptchaSolver } from '../../../../dist/captcha/solver.js';
import { getCaptchaCredentials } from '../../../../dist/utils/credentials.js';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: citations.mjs <arxiv_id|"title"> [...]');
  process.exit(2);
}

const PROXY_URL = process.env.PROXY_URL || 'residential';
const DELAY_S = parseFloat(process.env.SCHOLAR_DELAY_S || '6');
const NAV_RETRIES = parseInt(process.env.SCHOLAR_MAX_NAV_RETRIES || '3', 10);
const SESSION_REBUILDS = parseInt(process.env.SCHOLAR_MAX_SESSION_REBUILDS || '2', 10);
const LABEL = 'scholar_citations';

const creds = await getCaptchaCredentials();
const solver = new CaptchaSolver(creds);

let session = null;
let sessionAttempts = 0;

async function startSession() {
  sessionAttempts += 1;
  const s = await WSession.start({ label: LABEL, proxy: PROXY_URL });
  return s;
}

async function ensureSession() {
  if (session) {
    const stillAlive = session.page && !session.page.isClosed?.();
    if (stillAlive) return session;
    try { await session.close(); } catch (closeErr) { console.error('close error:', closeErr.message); }
    session = null;
  }
  if (sessionAttempts > SESSION_REBUILDS) {
    throw new Error(`session_rebuild_budget_exhausted after ${sessionAttempts} attempts`);
  }
  session = await startSession();
  return session;
}

async function safeEval(page, fn) {
  try { return { ok: true, value: await page.evaluate(fn) }; }
  catch (e) { return { ok: false, error: e }; }
}

async function clearCaptchas(page, s) {
  // retry-allowed: each captcha solve may surface another challenge; the
  // bounded pass count comes from the prior version of this script.
  for (let i = 0; i < 5; i++) {
    await solvePageCaptcha(page, solver, s);
    const r = await safeEval(page, () => {
      const t = document.body ? document.body.innerText : '';
      return t.includes("Please show you're not a robot")
        || t.includes('our systems have detected unusual traffic');
    });
    if (!r.ok) throw r.error;
    if (!r.value) return true;
    await s.wait(2);
  }
  return false;
}

async function navOnce(s, url) {
  await s.goto(url);
  await clearCaptchas(s.page, s);
  // retry-allowed: poll the DOM for the search result tile to render.
  for (let i = 0; i < 20; i++) {
    const r = await safeEval(s.page, () => !!document.querySelector('.gs_r'));
    if (r.ok && r.value) return true;
    await s.wait(1);
  }
  return false;
}

async function fetchOne(query) {
  const url = `https://scholar.google.com/scholar?hl=en&q=${encodeURIComponent(query)}`;
  let lastErr = null;
  for (let attempt = 0; attempt < NAV_RETRIES; attempt++) {
    let s;
    try {
      s = await ensureSession();
    } catch (e) {
      lastErr = e;
      break;
    }
    try {
      await navOnce(s, url);
    } catch (e) {
      lastErr = e;
      try { await session.close(); } catch (closeErr) { console.error('close error:', closeErr.message); }
      session = null;
      continue;
    }
    const r = await safeEval(s.page, () => {
      const div = document.querySelector('.gs_r.gs_or.gs_scl') || document.querySelector('.gs_r');
      if (!div) return { citations: null, title: null };
      const titleEl = div.querySelector('.gs_rt a');
      let citations = null;
      for (const a of div.querySelectorAll('.gs_fl a, a')) {
        const m = a.textContent && a.textContent.match(/Cited by (\d+)/);
        if (m) { citations = parseInt(m[1], 10); break; }
      }
      return {
        citations,
        title: titleEl ? titleEl.textContent.trim() : null,
      };
    });
    if (r.ok) return r.value;
    lastErr = r.error;
  }
  throw lastErr || new Error('all_nav_retries_exhausted');
}

console.log('key\tcitations\ttitle');
try {
  for (const arg of args) {
    try {
      const result = await fetchOne(arg);
      console.log(`${arg}\t${result.citations == null ? 'NA' : result.citations}\t${result.title || ''}`);
    } catch (e) {
      console.log(`${arg}\tERR\t${(e.message || '').slice(0, 200)}`);
    }
    await session?.wait(DELAY_S);
  }
} finally {
  if (session) {
    try { await session.close(); } catch (closeErr) { console.error('close error:', closeErr.message); }
  }
}
