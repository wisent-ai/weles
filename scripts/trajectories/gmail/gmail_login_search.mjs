// Gmail login + search trajectory (self-contained, no pre-seeded profile).
//
// Unlike gmail_search.mjs (which depends on a Google session previously
// established in the launchRealChrome persistent profile via
// setup_chrome_profile), this trajectory logs in from scratch with
// credentials, using a full WSession (patched Chromium 147 OR weles-firefox).
// Both engines now clear Google's "this browser or app may not be secure"
// gate: Chromium via the C++ --weles-fingerprint binary, Firefox via the
// 2026-05-19 fingerprint fix (coherent Gecko UA in persona.ts/fingerprint.ts +
// native navigator.webdriver — automation.js no longer JS-clobbers it on FF).
// Codified from a keeper session that drove this exact flow end-to-end on
// lukasz.bartoszcze@gmail.com (search "rent board"/"brick + timber"/radiator).
//
// Flow: WSession.start -> goto Gmail (redirects to accounts if logged out) ->
// googleSso(identifier+password) -> dismiss post-login speedbump ->
// #search/<query> -> read-only scrape of the result list -> open up to N
// threads and scrape their bodies -> structured PASS report.
//
// Run:  node scripts/trajectories/gmail/gmail_login_search.mjs
// Env:  GM_EMAIL     Google account (default lukasz.bartoszcze@gmail.com)
//       GM_PASSWORD  password; if unset, sourced from service_credentials
//                    via getGoogleSsoCreds()
//       GM_QUERY     Gmail search query (default: the rent/maintenance query)
//       GM_OPEN=0    list only, skip opening thread bodies
//       GM_MAX       max threads to open for body capture (default 6)
//       BROWSER      'firefox' | 'chromium' to pin the engine (default: roll)
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';

const DEFAULT_QUERY =
  '"rent board" OR "brick + timber" OR "brick and timber" OR radiator';
const QUERY = process.env.GM_QUERY || DEFAULT_QUERY;
const OPEN_BODIES = process.env.GM_OPEN !== '0';
const MAX_OPEN = parseInt(process.env.GM_MAX || '6', 10);
const INBOX_URL = 'https://mail.google.com/mail/u/0/#inbox';
const SEARCH_URL =
  'https://mail.google.com/mail/u/0/#search/' + encodeURIComponent(QUERY);

function log(...a) { console.log('[gmail_login_search]', ...a); }

// Locator.isVisible() rejects if the frame detached mid-navigation; treat that
// specific case as "not visible" via explicit try/catch (not a .catch
// sentinel) so a real evaluation error is still surfaced.
async function visible(loc) {
  try {
    return await loc.isVisible();
  } catch (e) {
    if (/detached|navigat|destroyed|closed/i.test(e.message || '')) return false;
    throw e;
  }
}

async function resolveCreds() {
  const email = process.env.GM_EMAIL || 'lukasz.bartoszcze@gmail.com';
  if (process.env.GM_PASSWORD) {
    return { email, password: process.env.GM_PASSWORD };
  }
  let fromDb = null;
  try {
    fromDb = await getGoogleSsoCreds(email);
  } catch (e) {
    log('getGoogleSsoCreds error: ' + (e.message || e));
  }
  if (fromDb?.password) return fromDb;
  throw new Error(
    'No password: set GM_PASSWORD or add a service_credentials row for ' + email,
  );
}

// Some accounts hit a post-login "speedbump" (passkey enrolment, recovery
// nudge). It is NOT a challenge — dismiss with the visible secondary button
// so the flow can continue to Gmail.
async function dismissSpeedbump(page) {
  for (let i = 0; i < 8; i++) {
    if (!/accounts\.google\.com/.test(page.url())) return;
    const btn = page
      .locator('button:has-text("Not now"), button:has-text("Skip"), button:has-text("Cancel")')
      .filter({ visible: true })
      .first();
    if (await visible(btn)) {
      log('dismissing post-login speedbump');
      try { await humanClickLocator(page, btn); }
      catch (e) { log('speedbump click: ' + e.message); }
      await humanIdlePause('deliberate');
      continue;
    }
    await humanIdlePause('short');
  }
}

// Returns 'in' | 'login' | 'unknown'. Mirrors gmail_search.mjs.
async function detectSession(page) {
  for (let i = 0; i < 40; i++) {
    if (/accounts\.google\.com|ServiceLogin|signin|challenge/.test(page.url())) {
      return 'login';
    }
    const rows = await page.locator('tr.zA').count();
    const empty = await visible(
      page.getByText(/No messages matched|No results found/i).first(),
    );
    if (rows > 0 || empty) return 'in';
    await humanIdlePause('short');
  }
  return 'unknown';
}

const creds = await resolveCreds();
const s = await WSession.start({
  label: 'gmail_login_search',
  browser: process.env.BROWSER || undefined,
});
try {
  log('engine:', s.personaConfig?.browser ?? 'unknown', '| query:', QUERY);
  await s.page.goto(INBOX_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');

  if (/accounts\.google\.com|ServiceLogin|signin/.test(s.page.url())) {
    log('logged out — running googleSso for', creds.email);
    const ok = await googleSso(s, creds);
    if (!ok) {
      log('FAIL: googleSso did not complete (url=' + s.page.url() + ').');
      await s.close();
      process.exit(2);
    }
    await dismissSpeedbump(s.page);
    log('signed in, at ' + s.page.url());
  } else {
    log('already signed in (existing session)');
  }

  await s.page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded' });
  const status = await detectSession(s.page);
  if (status !== 'in') {
    log('FAIL: search did not render (status=' + status + ', url='
      + s.page.url() + ').');
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
    const n = Math.min(rows.length, MAX_OPEN);
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
