// overleaf/list_auto.mjs — fully-automated Overleaf dashboard scrape.
//
// Sources the Google credentials for lukasz.bartoszcze@gmail.com from the
// weles service_credentials Supabase table via getGoogleSsoCreds(), opens an
// Overleaf session, drives "Sign in with Google" end-to-end via the existing
// _shared/services/google_sso.mjs helper, then scrapes the project dashboard.
// No manual login at any point.
//
// Pattern modeled on scripts/trajectories/oxylabs/topup.mjs.
//
// Env vars honored:
//   HEADLESS                 '1' = headless (default: visible window for
//                            debug; Google sometimes prefers a visible
//                            window for non-bot heuristics)
//   OVERLEAF_LIST_LIMIT      cap rows scraped (default 500)
//   OVERLEAF_LIST_INCLUDE    comma list: archived,trashed (default: none)
//   OUT_JSONL                file path to write JSONL stream (default stdout)
//
// Output: JSONL on stdout, one project per line, oldest-first by lastUpdated.
//         Recent-first summary table to stderr.
//
// Exit codes:
//   0 success; 1 no creds / no SSO completion; 2 page error (snapshot saved).

import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
import { createWriteStream } from 'node:fs';

const LIMIT    = Number(process.env.OVERLEAF_LIST_LIMIT || 500);
const INCLUDES = new Set((process.env.OVERLEAF_LIST_INCLUDE || '').split(',').map(s => s.trim()).filter(Boolean));
const OUT      = process.env.OUT_JSONL ? createWriteStream(process.env.OUT_JSONL) : process.stdout;

const login = await getGoogleSsoCreds();
if (!login) {
  console.error('FAIL: getGoogleSsoCreds() returned null. Check SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env, and that service_credentials has a row with login_email=lukasz.bartoszcze@gmail.com and login_password populated.');
  process.exit(1);
}
console.log(`[list_auto] Google creds loaded for ${login.email}`);

const s = await WSession.start({
  label: 'overleaf_list_auto',
  browser: 'chromium',
  headful: process.env.HEADLESS !== '1',
});

let pageError = null;
const rows = [];

try {
  await s.goto('https://www.overleaf.com/login');
  await humanIdlePause('short');

  // If a stored cookie jar already authenticates us, /login redirects to
  // /project — short-circuit the SSO dance.
  if (/\/project(\?|$|\/)/.test(s.page.url())) {
    console.log('[list_auto] already authenticated via persisted cookies');
  } else {
    // Dismiss the cookie banner if present — verified 2026-05-17 against
    // overleaf.com/login: the bottom banner has "Essential cookies only"
    // and "Accept all cookies" buttons. Use count() to test existence
    // (no try/catch swallow) and only click if a match is found.
    const cookieBtn = s.page.getByRole('button', { name: /essential cookies only|accept all cookies/i }).first();
    if (await cookieBtn.count() > 0) {
      console.log('[list_auto] dismissing cookie banner');
      await humanClickLocator(s.page, cookieBtn);
      await s.page.waitForTimeout(500);  // allow-raw-playwright: short cookie-banner dismiss settle
    }

    // Click "Log in with Google". Verified 2026-05-17 from rendered Overleaf
    // login page screenshot — button text is "Log in with Google" (not "Sign
    // in with..."), rendered as a <button>, not a link. Locator handles both.
    const googleBtn = s.page.getByRole('button', { name: /log in with google|sign in with google/i }).or(
      s.page.getByRole('link', { name: /log in with google|sign in with google/i })
    ).first();
    await googleBtn.waitFor({ state: 'visible' });
    let popupCaught = null;
    const popupPromise = s.page.waitForEvent('popup').then(p => { popupCaught = p; return p; }, () => null);
    await humanClickLocator(s.page, googleBtn);
    const popup = await Promise.race([
      popupPromise,
      new Promise(r => setTimeout(() => r(null), 5000)),  // allow-raw-playwright: Promise.race deadline
    ]);

    if (popup) {
      console.log('[list_auto] Google SSO opened in popup; driving popup');
      await popup.waitForLoadState('domcontentloaded');
      const ok = await googleSso(s, login, { originHost: 'overleaf.com', page: popup });
      if (!ok) {
        console.error('FAIL: Google SSO did not complete (popup mode)');
        process.exit(1);
      }
    } else {
      console.log('[list_auto] Google SSO is in-place redirect; driving main page');
      const ok = await googleSso(s, login, { originHost: 'overleaf.com' });
      if (!ok) {
        console.error('FAIL: Google SSO did not complete (in-place mode)');
        process.exit(1);
      }
    }

    // googleSso() returns true on a transient URL match — it can fire while
    // the OAuth redirect chain is still bouncing through google.com. Wait
    // for the URL to settle (unchanged for 3 consecutive checks @ 500ms),
    // off accounts.google.com, before we trust the session. If we settle on
    // overleaf.com/login* it means Overleaf rejected the OAuth (likely
    // reCAPTCHA challenge) — surface that as a real failure.
    let prev = '';
    let stableTicks = 0;
    let settledUrl = null;
    for (let i = 0; i < 60; i += 1) {
      await s.page.waitForTimeout(500);  // allow-raw-playwright: settle poll
      const u = s.page.url();
      if (u !== prev) {
        prev = u;
        stableTicks = 0;
        continue;
      }
      stableTicks += 1;
      if (stableTicks >= 3 && !/accounts\.google\.com/.test(u)) {
        settledUrl = u;
        break;
      }
    }
    const finalUrl = settledUrl !== null ? settledUrl : s.page.url();
    console.log(`[list_auto] settled URL: ${finalUrl}`);
    if (/\/login(\?|$|\/)/.test(finalUrl)) {
      console.error('FAIL: Overleaf returned to /login after SSO — OAuth rejected (reCAPTCHA challenge on callback).');
      const snapPath = `${process.env.HOME}/Documents/CodingProjects/Wisent/weles/.work/list_auto/overleaf_post_sso_rejected.png`;
      await s.page.screenshot({ path: snapPath, fullPage: true });
      console.error(`[list_auto] post-SSO rejection screenshot: ${snapPath}`);
      process.exit(1);
    }
    // If we're already on a /project URL (Overleaf's natural OAuth landing),
    // no explicit nav needed. Otherwise nudge to the dashboard.
    if (!/\/project(\?|$|\/)/.test(finalUrl)) {
      await s.goto('https://www.overleaf.com/project');
    }
  }

  // Wait for project anchors. Each row in Overleaf's dashboard contains an
  // anchor pointing to /project/<24hex>; the anchor itself is the most
  // stable identifier across UI versions.
  const anchorSel = 'a[href*="/project/"]';
  await s.page.locator(anchorSel).first().waitFor({ state: 'visible' });

  // Scroll progressively until anchor count stabilizes.
  let seen = 0;
  let stable = 0;
  const anchorLoc = s.page.locator(anchorSel);
  while (seen < LIMIT && stable < 5) {
    const current = await anchorLoc.count();
    if (current === 0) {
      throw new Error('no project anchors visible on dashboard');
    }
    const isStable = current === seen;
    stable = isStable ? stable + 1 : 0;
    seen = current;
    const last = anchorLoc.nth(current - 1);
    await last.scrollIntoViewIfNeeded();
  }
  const total = Math.min(seen, LIMIT);
  console.log(`[list_auto] project anchors found: ${total}`);

  // Page-side scrape. Uses explicit null returns when fields are missing;
  // the calling Node process decides what to do with nulls.
  const scraped = await s.page.evaluate(({ sel, cap }) => {
    function textOrNull(el) {
      if (!el) return null;
      const t = el.textContent;
      if (!t) return null;
      const trimmed = t.trim();
      return trimmed === '' ? null : trimmed;
    }
    function attrOrNull(el, name) {
      if (!el) return null;
      const v = el.getAttribute(name);
      if (v === null || v === '') return null;
      return v;
    }
    function pickName(anchor, row) {
      const a = textOrNull(anchor);
      if (a !== null) return a;
      if (!row) return null;
      return textOrNull(row.querySelector('[data-testid="project-name"], h3, .project-name'));
    }
    function pickLastUpdated(row) {
      if (!row) return null;
      const tEl = row.querySelector('time');
      const attr = attrOrNull(tEl, 'datetime');
      if (attr !== null) return attr;
      return textOrNull(tEl);
    }
    const links = Array.from(document.querySelectorAll(sel)).slice(0, cap);
    const byId = new Map();
    for (const a of links) {
      const href = a.getAttribute('href');
      if (!href) continue;
      const m = href.match(/\/project\/([0-9a-fA-F]{24})(?:[/?#]|$)/);
      if (!m) continue;
      const id = m[1];
      if (byId.has(id)) continue;
      // Walk up to find a row container with either a <time> child or a
      // relative-date phrase. Cap depth at 8.
      let row = a;
      for (let d = 0; d < 8 && row && row.parentElement; d += 1) {
        if (row.querySelector('time') || /\b(ago|hour|day|month|year)s?\b/i.test(row.innerText || '')) break;
        row = row.parentElement;
      }
      byId.set(id, {
        id,
        name: pickName(a, row),
        lastUpdated: pickLastUpdated(row),
        owner: row ? textOrNull(row.querySelector('[data-testid="project-owner"], .owner-name')) : null,
        ownerEmail: row ? textOrNull(row.querySelector('[data-testid="project-owner-email"]')) : null,
        archived: !!(row && row.closest && row.closest('[data-testid="archived-projects"], [data-filter="archived"]')),
        trashed: !!(row && row.closest && row.closest('[data-testid="trashed-projects"], [data-filter="trashed"]')),
      });
    }
    return Array.from(byId.values());
  }, { sel: anchorSel, cap: total });

  for (const r of scraped) {
    if (!r.id) continue;
    if (r.archived && !INCLUDES.has('archived')) continue;
    if (r.trashed && !INCLUDES.has('trashed')) continue;
    rows.push(r);
  }

  rows.sort((a, b) => String(a.lastUpdated || '').localeCompare(String(b.lastUpdated || '')));
  for (const r of rows) OUT.write(JSON.stringify(r) + '\n');

  const recent = [...rows].reverse().slice(0, 25);
  process.stderr.write(`\n==== Overleaf dashboard (${rows.length} projects scraped) ====\n`);
  process.stderr.write(`  id                        lastUpdated              name\n`);
  for (const r of recent) {
    process.stderr.write(`  ${(r.id || '-').padEnd(24)}  ${(r.lastUpdated || '-').padEnd(22)}  ${r.name || '-'}\n`);
  }
  if (rows.length > recent.length) {
    process.stderr.write(`  ... ${rows.length - recent.length} older not shown\n`);
  }
} catch (err) {
  pageError = err;
  console.error('[list_auto] error:', err?.message || err);
  try {
    // s.snapshot() doesn't exist on WSession; use the page screenshot API and
    // write to .work/<label>/ so the artifact-inspection helpers find it.
    const snapPath = `${process.env.HOME}/Documents/CodingProjects/Wisent/weles/.work/list_auto/overleaf_list_auto_failure.png`;
    await s.page.screenshot({ path: snapPath, fullPage: true });
    console.error(`[list_auto] failure screenshot: ${snapPath}`);
  } catch (snapErr) {
    console.error('[list_auto] snapshot also failed:', snapErr?.message || snapErr);
  }
}

if (OUT !== process.stdout) OUT.end();
await s.close();
if (pageError) process.exit(2);
process.exit(0);
