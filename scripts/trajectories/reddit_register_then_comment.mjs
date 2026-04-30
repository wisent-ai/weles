/**
 * Combined register-then-comment trajectory: registers a fresh Reddit account
 * AND posts a comment in the SAME WSession (same browser process, same
 * persona, same proxy sticky session, same localStorage/IndexedDB, same TLS
 * keys, same HTTP/2 connections, same in-page state). This mirrors a human
 * who registers and immediately comments in the same browser tab — the
 * scenario that's been shown to NOT get insta-shadowbanned.
 *
 * The atomic register/comment trajectories close the browser between actions,
 * which Reddit's anti-bot tags as "session moved to a new device" and
 * shadowbans within seconds of the first comment. This trajectory eliminates
 * that signal as a confound so we can see whether browser-process continuity
 * is the actual root cause.
 */
import { WSession } from '../../dist/session/wsession.js';
import { humanType } from '../../dist/human/keyboard.js';
import { humanMove, humanIdlePause, humanClickLocator } from '../../dist/human/mouse.js';
import { detectRedditBanSignals } from '../../dist/platforms/reddit/ban_signals.js';
import { randomBytes } from 'node:crypto';

const REGISTER_URL = 'https://www.reddit.com/register';
const TARGET_URL = process.env.TARGET_URL || 'https://www.reddit.com/r/test/comments/18da1zl/some_test_commands/';
// Comment body needs to be innocuous. The previous default "Hello from
// a fresh account on YYYY-MM-DD" literally announced both automation AND
// account-newness — two textual signals Reddit's spam classifier reads
// to decide shadowban. Use generic acknowledgement text instead.
const COMMENT_BODY = process.env.COMMENT_BODY || 'thanks for sharing';
const AGENT_DOMAIN = process.env.AGENT_DOMAIN ?? 'mailwisent.com';
const PROXY_FILTER = process.env.PROXY_URL || 'residential brightdata us';
const REAL_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

function genIdentity() {
  const F = 'Garry,Katie,Logan,Maya,Owen,Riley,Sage,Tess,Wes,Zane'.split(',');
  const L = 'Koepp,Bayer,Pratt,Quinn,Reeves,Stone,Vega,West,Yates,Cole'.split(',');
  const first = F[Math.floor(Math.random() * F.length)];
  const last = L[Math.floor(Math.random() * L.length)];
  const username = `${first.toLowerCase()}${last.toLowerCase()}${Math.floor(Math.random() * 9000 + 1000)}`;
  const email = `${username}@${AGENT_DOMAIN}`;
  const password = randomBytes(9).toString('base64').replace(/[+/=]/g, '') + '!A1';
  return { first, last, username, email, password, name: `${first} ${last}` };
}

const id = genIdentity();
console.log(`[register] identity: ${id.username} ${id.email}`);

const s = await WSession.start({ label: 'reddit_register_then_comment', proxy: PROXY_FILTER, browser: 'chromium', targetHost: 'www.reddit.com' });

async function vpJitter() {
  const vp = s.page.viewportSize(); if (!vp) return;
  await humanMove(s.page, 100 + Math.floor(Math.random() * (vp.width - 200)), 100 + Math.floor(Math.random() * (vp.height - 200)));
}

try {
  // ===== REGISTRATION =====
  await s.page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');
  await vpJitter();

  const emailIn = s.page.locator('input[type="email"], input[name="email"], input[autocomplete="email"]').filter({ visible: true }).first();
  await emailIn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, emailIn);
  await humanIdlePause('short');
  await humanType(s.page, id.email);
  await humanIdlePause('short');
  await vpJitter();
  await humanClickLocator(s.page, s.page.getByRole('button', { name: /continue/i }).filter({ visible: true }).first());
  console.log('[register] submitted email');

  await humanIdlePause('deliberate');
  const code = await s.checkEmail(id.email, 'reddit');
  if (/^error|^no code/.test(code)) throw new Error(`email_code_failed: ${code}`);
  console.log(`[register] got verification code: ${code}`);
  await humanIdlePause('short');
  await vpJitter();
  const codeIn = s.page.locator('input[autocomplete="one-time-code"], input[name="code"], input[type="text"][maxlength="6"]').filter({ visible: true }).first();
  await codeIn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, codeIn);
  await humanIdlePause('short');
  await humanType(s.page, code);
  await humanIdlePause('short');
  await humanClickLocator(s.page, s.page.getByRole('button', { name: /continue|verify|submit/i }).filter({ visible: true }).first());
  console.log('[register] submitted code');

  await humanIdlePause('deliberate');
  await vpJitter();
  const userIn = s.page.locator('input[name="username"], input[autocomplete="username"]').filter({ visible: true }).first();
  await userIn.waitFor({ state: 'visible' });
  // Diagnostic: what does the username field already contain? Reddit's
  // current /register flow auto-fills a suggested username (e.g.
  // "Melodic-Image-84sa77"). humanType would append to that, not replace.
  // Verified 2026-04-29: 2 of 2 fresh registrations ended up with the
  // auto-suggested name as the actual handle, even though we typed our
  // chosen username — meaning our typed input was either silently rejected
  // or appended to a too-long string that Reddit truncated back to the
  // suggestion.
  const beforeVal = await userIn.inputValue().catch(() => '?');
  console.log(`[register] username field BEFORE typing: "${beforeVal}"`);
  await humanClickLocator(s.page, userIn);
  // Reddit's React-controlled username field auto-fills a suggestion and
  // React re-renders it after keyboard Delete. The only reliable way to
  // clear React-controlled inputs is Playwright's .fill('') which calls
  // the React setter directly. After that, humanType chars one-by-one.
  // We can't use humanFill here because it does Ctrl+A + Delete which
  // React immediately re-fills. The .fill('') + humanType combo is the
  // only sequence that reliably clears React state AND produces real
  // keystrokes for the new value.
  for (let attempt = 0; attempt < 3; attempt++) {
    // Force-clear via Playwright's React-aware setter (bypasses humanFill).
    await userIn.fill('').catch(() => {}); // lint-allow: bare-fill
    await humanIdlePause('short');
    await humanType(s.page, id.username);
    const afterTypeVal = await userIn.inputValue().catch(() => '?');
    console.log(`[register] username attempt ${attempt + 1}: after typing "${id.username}": "${afterTypeVal}"`);
    if (afterTypeVal === id.username) break;
  }
  const afterTypeVal = await userIn.inputValue().catch(() => '?');
  if (afterTypeVal !== id.username) console.log(`[register] WARN: username field final value "${afterTypeVal}" != chosen "${id.username}" — Reddit may use the wrong handle`);
  await humanIdlePause('short');
  await vpJitter();
  const pwIn = s.page.locator('input[type="password"], input[autocomplete="new-password"]').filter({ visible: true }).first();
  await humanClickLocator(s.page, pwIn);
  await humanIdlePause('short');
  await humanType(s.page, id.password);
  await humanIdlePause('short');
  await vpJitter();
  await humanClickLocator(s.page, s.page.getByRole('button', { name: /sign up|continue|create/i }).filter({ visible: true }).first());
  console.log('[register] submitted username + password');

  for (let i = 0; i < 20; i++) {
    await s.page.waitForTimeout(1500);
    const u = s.page.url();
    if (!/\/register/.test(u)) break;
  }
  console.log(`[register] post-signup url=${s.page.url()}`);

  const result = await s.saveAccount('reddit', { username: id.username, email: id.email, password: id.password, name: id.name });
  console.log(`[register] saveAccount: ${result}`);

  // Brief pause — humans don't pivot from "account created" to "post comment"
  // in milliseconds. They look at the post-signup screen, maybe scroll, click
  // around. Match that loosely.
  await humanIdlePause('deliberate');
  await s.page.waitForTimeout(3000 + Math.floor(Math.random() * 4000));

  // Organic browsing before commenting — a real human doesn't register then
  // immediately navigate to a specific post to comment. They browse the home
  // feed, scroll a bit, maybe click a post. This browsing session creates
  // natural page-view events that Reddit's anti-bot looks for. Without it,
  // the registration→comment direct path is a detectable automation signal.
  console.log('[browse] organic session before comment');
  await s.page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');
  // Scroll the feed naturally — 3-5 scroll actions with variable dwell.
  const scrollCount = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < scrollCount; i++) {
    await s.page.waitForTimeout(2000 + Math.floor(Math.random() * 3000));
    await s.page.evaluate(() => window.scrollBy(0, 300 + Math.floor(Math.random() * 200)));
    await humanIdlePause('short');
  }
  // Click into a post from the feed — this creates a natural navigation event.
  const feedPost = s.page.locator('a[href*="/comments/"]').filter({ visible: true }).first();
  if (await feedPost.count()) {
    await humanClickLocator(s.page, feedPost);
    await humanIdlePause('deliberate');
    await s.page.waitForTimeout(3000 + Math.floor(Math.random() * 3000));
    // Scroll the post page.
    await s.page.evaluate(() => window.scrollBy(0, 200 + Math.floor(Math.random() * 200)));
    await s.page.waitForTimeout(2000);
  }
  console.log('[browse] done — now navigating to target post');

  // ===== COMMENT (same browser, same WSession, no close-and-reopen) =====
  const oldUrl = TARGET_URL.replace(/^https?:\/\/(www\.)?reddit\.com/, 'https://old.reddit.com');
  await s.page.goto(oldUrl, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');
  const postUrl = s.page.url();
  if (/\/login/.test(postUrl)) throw new Error(`comment phase: redirected to login (cookies invalid)`);

  const ta = s.page.locator('textarea[name="text"]').filter({ visible: true }).first();
  await ta.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, ta);
  await humanIdlePause('short');
  await ta.focus();
  await humanType(s.page, COMMENT_BODY);
  await humanIdlePause('short');
  await vpJitter();
  // Submit through humanClickLocator — full mouse trajectory + real
  // mousedown/up. Replaces the previous synthetic `evaluate(() => btn.click())`
  // which produced zero pointer events on the page and triggered Reddit's
  // behavioral bot classifier → hard ban within minutes of submit.
  const submitBtn = ta.locator('xpath=ancestor::form[1]').locator('button.save, button[type="submit"]').first();
  await submitBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, submitBtn);
  console.log('[comment] submitted');

  // Wait for the comment to appear in the page
  let postedLocally = false;
  for (let i = 0; i < 12; i++) {
    await s.page.waitForTimeout(1500);
    const txt = await s.page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    if (txt.includes(COMMENT_BODY)) { postedLocally = true; break; }
  }
  if (!postedLocally) throw new Error(`comment did not appear in page text after submit`);
  console.log(`[comment] visible in own page`);

  // Sample handle from /api/me.json (in-browser fetch — uses session)
  const realHandle = await s.page.evaluate(async () => {
    const r = await fetch('/api/me.json', { credentials: 'include' });
    const j = await r.json().catch(() => null);
    return j?.data?.name ?? null;
  });
  console.log(`[comment] real handle: ${realHandle}`);

  // Wait for the comment to surface in public listing (unauth probe).
  // CRITICAL: route ALL public-listing fetches through the page's APIRequestContext
  // so they go via the proxy. Node's global fetch goes via the host machine's
  // network — Reddit's edge returns HTML "Blocked" for that IP and the
  // includes()/JSON.parse fails, causing false-FAIL on actually-successful
  // comments. Verified 2026-04-29 with wesvega6929: Node fetch returned
  // HTML, ctx.request returned proper JSON with the comment.
  let publiclyVisible = false;
  let publicAboutStatus = 0;
  let inAuthListing = false;
  if (realHandle) {
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const resp = await s.page.context().request.get(`https://old.reddit.com/user/${encodeURIComponent(realHandle)}/comments/.json?limit=15&sort=new`, { headers: { 'Accept': 'application/json' }, ignoreHTTPSErrors: true, timeout: 15000 }).catch(() => null);
      const txt = resp ? await resp.text() : '';
      if (txt.includes(COMMENT_BODY)) { publiclyVisible = true; break; }
    }
    const aboutResp = await s.page.context().request.get(`https://old.reddit.com/user/${encodeURIComponent(realHandle)}/about.json`, { headers: { 'Accept': 'application/json' }, ignoreHTTPSErrors: true, timeout: 15000 }).catch(() => null);
    publicAboutStatus = aboutResp ? aboutResp.status() : 0;
    try {
      inAuthListing = await s.page.evaluate(async (handle, body) => {
        const r = await fetch(`/user/${encodeURIComponent(handle)}/comments/.json?limit=15&sort=new`, { credentials: 'include' });
        const j = await r.json().catch(() => null);
        return (j?.data?.children ?? []).some((c) => typeof c?.data?.body === 'string' && c.data.body.includes(body));
      }, realHandle, COMMENT_BODY);
    } catch { /* skip */ }
  }

  console.log(`[verify] publiclyVisible=${publiclyVisible} aboutStatus=${publicAboutStatus} inAuthListing=${inAuthListing}`);

  let verdict;
  if (publiclyVisible) verdict = 'PASS';
  else if (publicAboutStatus === 404) verdict = 'shadowbanned';
  else if (publicAboutStatus === 200 && inAuthListing) verdict = 'new_account_cooling';
  else if (inAuthListing) verdict = 'subreddit_filter';
  else verdict = 'rejected';

  if (verdict === 'PASS') {
    console.log(`PASS: ${id.username} -> commented "${COMMENT_BODY}" on ${oldUrl} (publicly visible)`);
  } else {
    console.log(`FAIL: ${id.username} -> ${verdict} (${publiclyVisible ? '' : 'not publicly visible'} aboutStatus=${publicAboutStatus} inAuthListing=${inAuthListing})`);
    process.exit(1);
  }
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 300));
  process.exit(1);
} finally {
  await s.close();
}
