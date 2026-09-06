// Gmail search trajectory.
//
// Pattern mirrors src/trajectories/google/gcp_credits.mjs and
// src/trajectories/_shared/services/setup_chrome_profile.mjs: it uses the
// launchRealChrome primitive (Weles Chromium 147, persistent context at
// ~/.weles/chrome_profiles/service_balance) and the Google session that was
// established once via the setup_chrome_profile trajectory.
//
// It navigates to a Gmail search, and:
//   - if the profile has no Google session -> prints FAIL + how to fix
//     (run the setup_chrome_profile trajectory), exits 2.
//   - if signed in -> read-only scrapes the result list (from / subject /
//     date / snippet) and opens up to six matching threads to capture body
//     text, printing a structured PASS report.
//
// Run:  node src/trajectories/gmail/gmail_search.mjs
// Env:  GM_QUERY  overrides the Gmail search query
//       GM_OPEN=0 skips opening thread bodies (list only)
import { launchRealChrome } from '../_shared/services/real_chrome.mjs';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';

const QUERY = process.env.GM_QUERY || 'newer_than:1y in:anywhere';
const OPEN_BODIES = process.env.GM_OPEN !== '0';
const SEARCH_URL =
  'https://mail.google.com/mail/u/0/#search/' + encodeURIComponent(QUERY);

function log(...a) { console.log('[gmail_search]', ...a); }

// Returns 'login' | 'in' | 'unknown'. Errors from locator calls propagate.
async function detectSession(page) {
  for (let i = 0; i < 40; i++) {
    if (/accounts\.google\.com|ServiceLogin|signin|challenge/.test(page.url())) {
      return 'login';
    }
    const rows = await page.locator('tr.zA').count();
    const empty = await page.getByText(/No messages matched|No results found/i)
      .first().isVisible();
    if (rows > 0 || empty) return 'in';
    await humanIdlePause('short');
  }
  return 'unknown';
}

const s = await launchRealChrome({ label: 'gmail_search' });
try {
  log('query:', QUERY);
  await s.page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded' });

  const status = await detectSession(s.page);
  if (status !== 'in') {
    log('FAIL: profile not signed in to Gmail (status=' + status + ', url='
      + s.page.url() + ').');
    log('Fix: run src/trajectories/_shared/services/setup_chrome_profile.mjs');
    log('and sign in once; the session persists for this trajectory.');
    await s.close();
    process.exit(2);
  }

  const rows = await s.page.evaluate(() => { // allow-raw-playwright: read-only DOM text scrape of the inbox result list, no synthetic interaction
    const out = [];
    const trs = Array.from(document.querySelectorAll('tr.zA')).slice(0, 40);
    for (const r of trs) {
      const fEl = r.querySelector('.yW span[email]') ||
                  r.querySelector('.yW span') || r.querySelector('.zF');
      const sEl = r.querySelector('.bog');
      const dEl = r.querySelector('.xW span[title]') || r.querySelector('.xW span');
      const snEl = r.querySelector('.y2');
      out.push({
        from: fEl ? (fEl.getAttribute('email') || fEl.textContent || '').trim() : '',
        subject: sEl ? (sEl.textContent || '').trim() : '',
        date: dEl ? (dEl.getAttribute('title') || dEl.textContent || '').trim() : '',
        snippet: snEl ? (snEl.textContent || '').trim() : '',
      });
    }
    return out;
  });

  log('PASS: signed in. ' + rows.length + ' threads match the query');
  console.log('================ THREAD LIST ================');
  rows.forEach((r, i) => {
    console.log(`#${i + 1} | ${r.date} | ${r.from}`);
    console.log(`     SUBJ: ${r.subject}`);
    console.log(`     SNIP: ${r.snippet}`);
  });

  if (OPEN_BODIES && rows.length) {
    console.log('================ THREAD BODIES ================');
    const n = Math.min(rows.length, 6);
    for (let idx = 0; idx < n; idx++) {
      try {
        await humanClickLocator(s.page, s.page.locator('tr.zA').nth(idx));
        await s.page.locator('.a3s, div[role="listitem"] .ii').first()
          .waitFor({ state: 'visible' });
        await humanIdlePause('short');
        const body = await s.page.evaluate(() => { // allow-raw-playwright: read-only DOM text scrape of an opened email body, no synthetic interaction
          const subj = document.querySelector('h2.hP');
          const blocks = Array.from(document.querySelectorAll('.a3s'))
            .map((b) => b.innerText.trim()).filter(Boolean);
          return {
            subj: subj ? subj.textContent.trim() : '',
            text: blocks.join('\n---\n').slice(0, 4000),
          };
        });
        console.log(`\n>>> THREAD #${idx + 1}: ${body.subj}`);
        console.log(body.text);
        await s.page.goBack({ waitUntil: 'domcontentloaded' }); // allow-raw-playwright: navigate back to the result list, no bot-classified interaction
        await s.page.locator('tr.zA').first().waitFor({ state: 'visible' });
      } catch (e) {
        console.log(`\n>>> THREAD #${idx + 1}: (failed to open: ${e.message})`);
      }
    }
  }

  log('done.');
  await s.close();
} catch (e) {
  log('ERROR: ' + (e && e.stack || e));
  try { await s.close(); } catch (ce) { log('close failed: ' + ce.message); }
  process.exit(1);
}
