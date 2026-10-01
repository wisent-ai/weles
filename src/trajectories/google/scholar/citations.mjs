import { pageSettled } from '../../_shared/page/settled.mjs';
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
const LABEL = 'scholar_citations';

const creds = await getCaptchaCredentials();
const solver = new CaptchaSolver(creds);

let session = null;

async function ensureSession() {
  if (session && session.page && !session.page.isClosed?.()) return session;
  session = await WSession.start({ label: LABEL, proxy: PROXY_URL });
  return session;
}

async function safeEval(page, fn) {
  try { return { ok: true, value: await page.evaluate(fn) }; }
  catch (e) { return { ok: false, error: e }; }
}

// One captcha solve per page: a second challenge after a solved one means
// Google is rate-limiting this exit, which another token does not change.
async function clearCaptchas(page, s) {
  const gated = async () => {
    // Google's rate-limit interstitial is its /sorry/ page, or a captcha
    // form rendered in place of the results.
    const r = await safeEval(page, () => location.pathname.startsWith('/sorry')
      || !!document.querySelector('#captcha-form, #gs_captcha_f, iframe[src*="recaptcha"]'));
    if (!r.ok) throw r.error;
    return r.value;
  };
  if (!await gated()) return;
  await solvePageCaptcha(page, solver, s);
  await pageSettled(s.page);
  if (await gated()) throw new Error('scholar_rate_limited: the captcha came back after it was solved');
}

async function navOnce(s, url) {
  await s.goto(url);
  await pageSettled(s.page);
  await clearCaptchas(s.page, s);
  const r = await safeEval(s.page, () => !!document.querySelector('.gs_r'));
  if (!r.ok) throw r.error;
  if (!r.value) throw new Error(`scholar_no_results: the settled page shows no result tile (${s.page.url()})`);
}

async function fetchOne(query) {
  const url = `https://scholar.google.com/scholar?hl=en&q=${encodeURIComponent(query)}`;
  const s = await ensureSession();
  await navOnce(s, url);
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
  if (!r.ok) throw r.error;
  return r.value;
}

console.log('key\tcitations\ttitle');
try {
  for (const arg of args) {
    try {
      const result = await fetchOne(arg);
      console.log(`${arg}\t${result.citations == null ? 'NA' : result.citations}\t${result.title || ''}`);
    } catch (e) {
      console.log(`${arg}\tERR\t${(e.message || '')}`);
    }
  }
} finally {
  if (session) {
    try { await session.close(); } catch (closeErr) { console.error('close error:', closeErr.message); }
  }
}
