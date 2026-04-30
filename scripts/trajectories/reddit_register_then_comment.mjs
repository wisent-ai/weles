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
import { humanMove, humanIdlePause, humanClickLocator, humanScroll } from '../../dist/human/mouse.js';
import { detectRedditBanSignals } from '../../dist/platforms/reddit/ban_signals.js';
import { generateOrganicComment } from './_shared/llm.mjs';
import { randomBytes } from 'node:crypto';

const REGISTER_URL = 'https://www.reddit.com/register';
// Subreddit choice is DYNAMIC. Same pattern as scripts/trajectories/reddit/
// organic_comment.mjs: if SUBREDDIT env unset (or 'popular' / 'all'), roll
// from a curated newbie-tolerant list (high comment volume, light AutoMod,
// no karma gate). Caller can also pass an explicit sub name to target it.
const NEWBIE_FRIENDLY_SUBS = [
  'CasualConversation', 'AskOldPeople', 'AskReddit', 'NoStupidQuestions',
  'mildlyinteresting', 'todayilearned', 'AskMen', 'AskWomen',
];
const RAW_SUBREDDIT = process.env.SUBREDDIT || 'popular';
const SUBREDDIT = (RAW_SUBREDDIT === 'popular' || RAW_SUBREDDIT === 'all')
  ? NEWBIE_FRIENDLY_SUBS[Math.floor(Math.random() * NEWBIE_FRIENDLY_SUBS.length)]
  : RAW_SUBREDDIT;
// Comment body — by default generated via the persona-aware LLM endpoint
// (same pipeline as scripts/trajectories/reddit/organic_comment.mjs), using
// the just-registered identity as the persona and the actual post's
// title/body as context. Overridable via $COMMENT_BODY for tests where
// you want a deterministic body.
const COMMENT_BODY_OVERRIDE = process.env.COMMENT_BODY || null;
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
  // Scroll the feed via REAL wheel events (humanScroll). Previous
  // implementation used `page.evaluate(window.scrollBy)` which produces
  // ZERO wheel events on the page — synthetic scroll is a strong bot
  // signal because Reddit's behavioral telemetry expects a stream of
  // wheel events with realistic deltas/timing, not a teleporting scroll
  // position. Switch to humanScroll which dispatches real wheel events
  // through Playwright's mouse.wheel API with multi-burst pattern +
  // realistic dwell.
  await humanScroll(s.page, 1200 + Math.floor(Math.random() * 800), 3 + Math.floor(Math.random() * 3));
  // Click into a post from the feed — this creates a natural navigation event.
  const feedPost = s.page.locator('a[href*="/comments/"]').filter({ visible: true }).first();
  if (await feedPost.count()) {
    await humanClickLocator(s.page, feedPost);
    await humanIdlePause('deliberate');
    await s.page.waitForTimeout(3000 + Math.floor(Math.random() * 3000));
    // Real wheel scroll on the post page — same anti-bot reasoning as above.
    await humanScroll(s.page, 600 + Math.floor(Math.random() * 400), 2);
    await s.page.waitForTimeout(2000);
  }
  console.log(`[browse] done — picking post from r/${SUBREDDIT}`);

  // ===== COMMENT via OLD-reddit (proven-working path) =====
  // Empirical finding 2026-04-30: comments submitted via old.reddit.com surface
  // publicly more reliably than NEW-reddit shreddit-composer comments
  // (which got shadow-removed even with identical bot-detection signals).
  //
  // Pick a post DYNAMICALLY from r/<SUBREDDIT> /new listing — same approach
  // as scripts/trajectories/reddit/organic_comment.mjs. Fetch via in-page
  // fetch so it goes through session cookies + proxy.
  const sortPath = SUBREDDIT === 'popular' || SUBREDDIT === 'all'
    ? `/r/${SUBREDDIT}/new`
    : `/r/${SUBREDDIT}`;
  const listingUrl = `https://www.reddit.com${sortPath}/.json?limit=50&raw_json=1`;
  const listingData = await s.page.evaluate(async (u) => {
    try { const r = await fetch(u, { credentials: 'include' }); if (!r.ok) return null; return await r.json(); } catch { return null; }
  }, listingUrl).catch(() => null);
  let postUrlWww = null, postTitle = '', postBody = '';
  try {
    const candidates = (listingData?.data?.children ?? [])
      .map(c => c.data)
      .filter(p => p && !p.locked && !p.archived && p.num_comments < 2000);
    const pick = candidates[Math.floor(Math.random() * Math.min(candidates.length, 12))];
    if (pick) { postUrlWww = `https://www.reddit.com${pick.permalink}`; postTitle = pick.title || ''; postBody = pick.selftext || ''; }
  } catch (e) { console.log('[listing-parse]', e.message); }
  if (!postUrlWww) throw new Error(`no eligible post found in r/${SUBREDDIT}`);
  console.log(`[comment] picked post: ${postTitle.slice(0, 80)}`);

  // Generate comment body via the persona-aware LLM endpoint, with the
  // identity from genIdentity() as the persona and the actual post as
  // context. This mirrors the existing organic_comment.mjs flow so the
  // body fits the post (no hardcoded boilerplate that fingerprints us).
  let COMMENT_BODY;
  if (COMMENT_BODY_OVERRIDE) {
    COMMENT_BODY = COMMENT_BODY_OVERRIDE;
  } else {
    COMMENT_BODY = await generateOrganicComment({
      persona: { name: id.name, bio: '', personality: '', niche: '' },
      post: { surface: `r/${SUBREDDIT}`, title: postTitle, body: postBody },
    });
  }
  console.log(`[comment-text] ${COMMENT_BODY.slice(0, 120)}`);

  const oldRedditUrl = postUrlWww.replace(/^https?:\/\/(www\.|new\.)?reddit\.com/, 'https://old.reddit.com');
  await s.page.goto(oldRedditUrl, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');
  await s.page.waitForTimeout(2000 + Math.floor(Math.random() * 1500));

  const postUrl = s.page.url();
  console.log(`[comment] post-page url=${postUrl}`);
  if (/\/login/.test(postUrl)) throw new Error(`comment phase: redirected to login (cookies invalid)`);

  // OLD-reddit comment textarea is inside the top-level reply form. The
  // structure is:
  //   <div class="commentarea">
  //     <div class="usertext-edit md-container">
  //       <textarea name="text"></textarea>
  //     </div>
  //     <button class="save">save</button>
  //   </div>
  // Note: form may be wrapped or cloneable. We probe to find what's there.
  const probe = await s.page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('textarea'));
    const meta = all.map(t => ({
      name: t.name,
      visible: t.offsetParent !== null,
      rect: (() => { const r = t.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; })(),
      parent: t.parentElement?.className?.slice(0, 60),
      grand: t.parentElement?.parentElement?.className?.slice(0, 60),
    }));
    const ca = document.querySelector('.commentarea');
    const hasForm = !!document.querySelector('form.usertext');
    const isLoggedIn = !!document.querySelector('a[href*="/user/"]') && !document.querySelector('.login-required');
    return { textareas: meta, hasCommentArea: !!ca, hasForm, isLoggedIn, title: document.title };
  });
  console.log(`[comment] probe: ${JSON.stringify(probe).slice(0, 800)}`);

  // Find the visible top-level reply textarea[name="text"]. Each existing
  // comment in the thread also has a (hidden) reply form with its own
  // textarea[name="text"], so .first() works only if the top-level form
  // is first in DOM order — which it is on old.reddit post pages.
  const textarea = s.page.locator('textarea[name="text"]').first();
  await textarea.waitFor({ state: 'visible', timeout: 15000 });
  await humanClickLocator(s.page, textarea);
  await humanIdlePause('short');
  await humanType(s.page, COMMENT_BODY);
  await humanIdlePause('short');
  await vpJitter();

  // CRITICAL: scope the submit button to the SAME form as the textarea.
  // Otherwise `button.save` first-on-page can match a "save comment" button
  // attached to an existing thread-comment, which submits to a different
  // endpoint and produces shadow-removal. Diff vs the visible-comment trace
  // (wespratt2656) confirmed: original committed trajectory used
  // ancestor::form[1] scoping, which submitted to relative /api/comment;
  // unscoped button.save picked a different button submitting to absolute
  // https://www.reddit.com/api/comment, going through new-reddit's spam
  // filter (always shadow_removed for new accounts).
  const submitBtn = textarea.locator('xpath=ancestor::form[1]').locator('button.save, button[type="submit"]').first();
  await submitBtn.waitFor({ state: 'visible', timeout: 10000 });
  await humanClickLocator(s.page, submitBtn);
  console.log('[comment] submitted via form-scoped submit button');

  // Wait briefly for the comment to appear in-page. This is best-effort —
  // old.reddit's DOM update after submit can lag past our timeout window
  // even when the comment posted successfully (verified 2026-04-30 with
  // zanestone9232: in-page check timed out, but the comment was publicly
  // visible via unauth permalink fetch). Don't fail on this signal —
  // the canonical truth is the user-listing + post-thread probes below.
  let postedLocally = false;
  for (let i = 0; i < 12; i++) {
    await s.page.waitForTimeout(1500);
    const txt = await s.page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    if (txt.includes(COMMENT_BODY)) { postedLocally = true; break; }
  }
  console.log(`[comment] in-page check: ${postedLocally ? 'visible' : 'not seen yet (proceeding to API verify)'}`);

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
  // Reddit's three visibility planes — must check ALL of them to distinguish
  // shadow-removal from real public visibility:
  //
  //   1. inUserListing  — /user/<handle>/comments/.json
  //      Always shows the author's own comments, even when removed by the
  //      subreddit's spam filter or AutoModerator. This was the previous
  //      single source of truth and produced FALSE POSITIVES — every
  //      shadow-removed comment was reported as "publicly visible" because
  //      it shows up here.
  //
  //   2. inPostThread   — /r/<sub>/comments/<post_id>/<slug>/.json
  //      The comment tree on the actual post. Filtered comments are HIDDEN
  //      here. This is the real "can other users see it" signal.
  //
  //   3. aboutStatus    — /user/<handle>/about.json
  //      404 = full account shadowban, 200 = account exists.
  //
  // True PASS = inUserListing AND inPostThread AND aboutStatus===200.
  // shadow_removed = inUserListing AND aboutStatus===200 AND NOT inPostThread.
  let inUserListing = false;
  let inPostThread = false;
  let publicAboutStatus = 0;
  let inAuthListing = false;
  let commentPermalink = '';
  let commentLinkId = '';
  let commentId = '';

  if (realHandle) {
    // 1. Find comment in user listing + extract its permalink + parent post id.
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const resp = await s.page.context().request.get(`https://old.reddit.com/user/${encodeURIComponent(realHandle)}/comments/.json?limit=15&sort=new`, { headers: { 'Accept': 'application/json' }, ignoreHTTPSErrors: true, timeout: 15000 }).catch(() => null);
      if (!resp) continue;
      const txt = await resp.text();
      if (!txt.includes(COMMENT_BODY)) continue;
      try {
        const j = JSON.parse(txt);
        const child = (j?.data?.children ?? []).find((c) => typeof c?.data?.body === 'string' && c.data.body.includes(COMMENT_BODY));
        if (child) {
          inUserListing = true;
          commentPermalink = child.data.permalink || '';
          commentLinkId = (child.data.link_id || '').replace(/^t3_/, '');
          commentId = (child.data.id || '');
          break;
        }
      } catch { /* parse error — try again */ }
    }

    // 2. Account-level shadowban probe.
    const aboutResp = await s.page.context().request.get(`https://old.reddit.com/user/${encodeURIComponent(realHandle)}/about.json`, { headers: { 'Accept': 'application/json' }, ignoreHTTPSErrors: true, timeout: 15000 }).catch(() => null);
    publicAboutStatus = aboutResp ? aboutResp.status() : 0;

    // 3. Authenticated user listing (sanity check — comment should always be here).
    try {
      inAuthListing = await s.page.evaluate(async (handle, body) => {
        const r = await fetch(`/user/${encodeURIComponent(handle)}/comments/.json?limit=15&sort=new`, { credentials: 'include' });
        const j = await r.json().catch(() => null);
        return (j?.data?.children ?? []).some((c) => typeof c?.data?.body === 'string' && c.data.body.includes(body));
      }, realHandle, COMMENT_BODY);
    } catch { /* skip */ }

    // 4. Post-thread probe — the canonical "can outsiders see it" check.
    // CRITICAL: must be UNAUTHENTICATED. The page's context.request inherits
    // session cookies, so it sees the user's own filtered comments — that
    // produced false positives ("inPostThread=true" while public unauth
    // fetch returned 0 comments). Use Playwright's request.newContext()
    // for a fresh cookie-less context that goes through the same proxy.
    if (commentPermalink) {
      // Allow ~10s of propagation between submit and probe. Reddit's edge
      // caches permalink JSON briefly; a too-eager probe occasionally sees
      // the comment before sub filter applies.
      await new Promise(r => setTimeout(r, 8000));
      const { request: pwRequest } = await import('playwright');
      // Inherit the session's proxy (so we hit Reddit from the same IP) but
      // not its cookies — that's how anyone-but-us would see the post.
      const sessProxy = s.proxyConfig;
      const unauthCtx = await pwRequest.newContext({
        userAgent: REAL_UA,
        extraHTTPHeaders: { Accept: 'application/json' },
        ignoreHTTPSErrors: true,
        ...(sessProxy?.server && { proxy: { server: sessProxy.server, username: sessProxy.username, password: sessProxy.password } }),
      });
      const permalinkJson = `https://www.reddit.com${commentPermalink.replace(/\/$/, '')}.json`;
      const permaResp = await unauthCtx.get(permalinkJson, { timeout: 15000 }).catch(() => null);
      if (permaResp) {
        try {
          const txt = await permaResp.text();
          const j = JSON.parse(txt);
          const tree = Array.isArray(j) ? j[1] : null;
          const collect = (children) => {
            const acc = [];
            for (const c of (children || [])) {
              if (c?.data?.body && c.data.body.includes(COMMENT_BODY)) acc.push(c.data);
              const replies = c?.data?.replies?.data?.children;
              if (replies) acc.push(...collect(replies));
            }
            return acc;
          };
          const matches = collect(tree?.data?.children);
          inPostThread = matches.length > 0;
        } catch { /* parse error */ }
      }
      await unauthCtx.dispose().catch(() => {});
    }
  }

  console.log(`[verify] inUserListing=${inUserListing} inPostThread=${inPostThread} aboutStatus=${publicAboutStatus} inAuthListing=${inAuthListing} permalink=${commentPermalink}`);

  let verdict;
  if (publicAboutStatus === 404) verdict = 'shadowbanned';
  else if (inPostThread && inUserListing) verdict = 'PASS';
  else if (inUserListing && !inPostThread) verdict = 'shadow_removed';
  else if (inAuthListing && !inUserListing) verdict = 'rate_limited_or_filtered';
  else verdict = 'rejected';

  if (verdict === 'PASS') {
    console.log(`PASS: ${id.username} -> commented "${COMMENT_BODY}" -> https://www.reddit.com${commentPermalink} (visible in post thread)`);
  } else {
    console.log(`FAIL: ${id.username} -> ${verdict} | inUserListing=${inUserListing} inPostThread=${inPostThread} aboutStatus=${publicAboutStatus} inAuthListing=${inAuthListing}`);
    process.exit(1);
  }
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 300));
  process.exit(1);
} finally {
  await s.close();
}
