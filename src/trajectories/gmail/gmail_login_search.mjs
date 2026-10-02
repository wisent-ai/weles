// Gmail login + search trajectory (self-contained, no pre-seeded profile).
//
// Unlike gmail_search.mjs (which depends on a Google session previously
// established in the launchRealChrome persistent profile via
// setup_chrome_profile), this trajectory logs in from scratch with
// credentials, using a full WSession (patched Chromium 147 OR weles-firefox).
// Chromium uses the --weles-fingerprint binary. Firefox uses a coherent Gecko
// user agent and native navigator.webdriver rather than a JavaScript override.
//
// Flow: WSession.start -> goto Gmail (redirects to accounts if logged out) ->
// googleSso(identifier+password) -> dismiss post-login speedbump ->
// #search/<query> -> read-only scrape of the result list -> open up to N
// threads and scrape their bodies -> structured PASS report.
//
// Run:  node src/trajectories/gmail/gmail_login_search.mjs
// Credentials are resolved from the dedicated Gmail Skarbiec item.
//       GM_QUERY     required nonempty Gmail search query; no account-specific default
//       GM_OPEN=0    list only, skip opening thread bodies
//       GM_MAX       max threads to open for body capture (default 6)
//       BROWSER      'firefox' | 'chromium' to pin the engine (default: roll)
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso } from '../_shared/services/google_sso.mjs';
import { DOCUMENT_REPLACED, readAcrossNavigation } from '../_shared/services/google_sso/page_diagnostics.mjs';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { pageSettled } from '../_shared/page/settled.mjs';
import { readScopedLogin } from '../../_shared/scoped-secrets.mjs';

const QUERY = process.env.GM_QUERY;
if (typeof QUERY !== 'string' || !QUERY.trim()) {
  throw new Error('GMAIL_QUERY_REQUIRED: GM_QUERY must be a nonempty Gmail search query');
}
const OPEN_BODIES = process.env.GM_OPEN !== '0';
const MAX_OPEN = parseInt(process.env.GM_MAX || '6', 10);
const CREDENTIAL_SERVICE = process.env.GM_CREDENTIAL_SERVICE === 'googleSso'
  ? 'googleSso'
  : 'gmail';
function gmailUrl(email, fragment) {
  return 'https://mail.google.com/mail/u/0/?tab=rm&ogbl&authuser='
    + encodeURIComponent(email) + '#' + fragment;
}

function log(...a) { console.log('[gmail_login_search]', ...a); }

// Locator.isVisible() rejects when its document is replaced mid-navigation;
// that case (reported by the page, not read from the error's words) is "not
// visible", and any other failure is surfaced.
async function visible(loc) {
  const shown = await readAcrossNavigation(loc.page(), () => loc.isVisible());
  return shown === DOCUMENT_REPLACED ? false : shown;
}

async function resolveCreds() {
  return readScopedLogin(CREDENTIAL_SERVICE);
}

// Some accounts hit a post-login "speedbump" (passkey enrolment, recovery
// nudge). It is NOT a challenge — dismiss with the visible secondary button
// so the flow can continue to Gmail.
async function dismissSpeedbump(page) {
  const dismissed = new Set();
  for (;;) {
    await pageSettled(page);
    const url = page.url();
    if (new URL(url).hostname !== 'accounts.google.com') return;
    const btn = page
      .locator('button:has-text("Not now"), button:has-text("Skip"), button:has-text("Cancel")')
      .filter({ visible: true })
      .first();
    if (!(await visible(btn))) {
      throw new Error(`GMAIL_POST_LOGIN_CONTROL_UNAVAILABLE: no offered dismissal control at ${url}`);
    }
    const control = await btn.innerText();
    const state = JSON.stringify([url, control]);
    if (dismissed.has(state)) {
      throw new Error(`GMAIL_POST_LOGIN_STATE_REPEATED: the dismissed control remained at ${url}`);
    }
    dismissed.add(state);
    log('dismissing post-login speedbump');
    await humanClickLocator(page, btn);
  }
}

// Returns 'in' or 'login' from observed page state. Browser failures propagate.
async function detectSession(page) {
  for (;;) {
    if (/accounts\.google\.com|ServiceLogin|signin|challenge/.test(page.url())) {
      return 'login';
    }
    const rows = await page.locator('tr.zA').count();
    const empty = await visible(
      page.getByText(/No messages matched|No results found|did not match any messages/i).first(),
    );
    if (rows > 0 || empty) return 'in';
    await pageSettled(page);
  }
}

async function needsGoogleLogin(page) {
  if (new URL(page.url()).hostname !== 'mail.google.com') return true;
  if (/accounts\.google\.com|ServiceLogin|signin|challenge/.test(page.url())) return true;
  const heading = await page.getByRole('heading', { name: /^Sign in$/i }).count();
  if (heading > 0) return true;
  const identifier = await page.locator('input[type="email"], input[name="identifier"], input#identifierId').count();
  return identifier > 0;
}

const creds = await resolveCreds();
const inboxUrl = gmailUrl(creds.email, 'inbox');
const searchUrl = gmailUrl(creds.email, 'search/' + encodeURIComponent(QUERY));
const s = await WSession.start({
  label: 'gmail_login_search',
  browser: process.env.BROWSER || undefined,
});
try {
  log('engine:', s.personaConfig?.browser ?? 'unknown', '| query:', QUERY);
  await s.page.goto(inboxUrl, { waitUntil: 'domcontentloaded' });
  await pageSettled(s.page);

  const gmailNeedsLogin = await needsGoogleLogin(s.page);
  if (gmailNeedsLogin) {
    const useAnotherAccount = s.page.getByText(/^Use another account$/i).first();
    if (await visible(useAnotherAccount)) {
      log('choosing another Google account');
      await humanClickLocator(s.page, useAnotherAccount);
      await pageSettled(s.page);
    }
  }
  if (gmailNeedsLogin) {
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

  await s.page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
  await pageSettled(s.page);
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
        throw e;
      }
    }
  }

  log('done.');
  await s.close();
  process.exit(0);
} catch (e) {
  log('ERROR: ' + (e && e.stack || e));
  try { await s.close(); } catch (ce) { log('close failed: ' + ce.message); }
  process.exit(1);
}
