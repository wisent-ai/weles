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
import { humanMove, humanIdlePause, humanClickLocator, humanScroll, humanHoverDwell } from '../../dist/human/mouse.js';
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
// Submit-path: 'old' (default, proven-working) or 'new' (shreddit-composer
// on www.reddit.com). 'new' is experimental — kept as a switch to enable
// further bot-detection diff work against chrome-human (which uses new-reddit).
const SUBMIT_PATH = (process.env.NEW_REDDIT === '1' || process.env.SUBMIT_PATH === 'new') ? 'new' : 'old';
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

function decodeHtmlAttr(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractCommentFromCreateResponse(body, expectedBody) {
  const html = decodeHtmlAttr(body);
  const needle = String(expectedBody || '').trim().slice(0, 50);
  if (needle && !html.includes(needle)) return null;
  const permalink = html.match(/\bpermalink="([^"]+)"/i)?.[1] || '';
  const thing = html.match(/\bthingid="t1_([a-z0-9]+)"/i)?.[1] || html.match(/\bthingId="t1_([a-z0-9]+)"/)?.[1] || '';
  const link = permalink.match(/\/comments\/([a-z0-9]+)\//i)?.[1] || '';
  if (!permalink && !thing) return null;
  return {
    permalink: permalink.startsWith('/') ? permalink : `/${permalink.replace(/^https?:\/\/[^/]+\//, '')}`,
    id: thing,
    linkId: link,
  };
}

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
  // Navigate directly to r/<SUBREDDIT>/new feed page. Sorted by NEW so the
  // posts visible in the feed match the JSON API listing we'll pick from.
  // The human-handoff run spent ~45 seconds on r/CasualConversation before
  // clicking into a post; during that dwell Reddit wrote
  // Storage.setItem:good-visit-feeds-search (3x) and
  // Storage.setItem:pathname-page-type-map (3x) — engagement-quality
  // telemetry that the prior trajectory never triggered (0 setItem writes
  // in the diff). Without good-visit signals, Reddit's anti-spam scores
  // the session as "no genuine engagement" and shadow-removes the first
  // comment from a fresh account.
  // Feed + listing sort: use /new so the visible feed matches the API listing.
  const listingSort = 'new';
  const feedUrl = SUBREDDIT === 'popular' || SUBREDDIT === 'all'
    ? 'https://www.reddit.com/'
    : `https://www.reddit.com/r/${SUBREDDIT}/${listingSort}/`;
  await s.page.goto(feedUrl, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');
  // Long feed dwell (8-15s) so Reddit's good-visit tracker fires.
  // The property-trap diff showed setItem:good-visit-feeds-search firing
  // on the feed page URL only when the session dwelled >5s; the prior
  // trajectory's 2-3s feed visit never triggered it.
  await s.page.waitForTimeout(8000 + Math.floor(Math.random() * 7000));
  // Scroll the feed via REAL wheel events (humanScroll). Previous
  // implementation used `page.evaluate(window.scrollBy)` which produces
  // ZERO wheel events on the page — synthetic scroll is a strong bot
  // signal because Reddit's behavioral telemetry expects a stream of
  // wheel events with realistic deltas/timing, not a teleporting scroll
  // position. Switch to humanScroll which dispatches real wheel events
  // through Playwright's mouse.wheel API with multi-burst pattern +
  // realistic dwell.
  await humanScroll(s.page, 1200 + Math.floor(Math.random() * 800), 3 + Math.floor(Math.random() * 3));
  // Hover a username link on the feed page — triggers
  // faceplate-hovercard:open / rpl-hovercard:after-show on the FEED
  // page (where the component is fully loaded). The human-handoff diff
  // showed 31x faceplate-hovercard:open subscribers on the feed page;
  // the trajectory had only 36 (from the home page, not the subreddit).
  await humanHoverDwell(
    s.page,
    s.page.locator('a[href^="/user/"], a[href*="/user/"]').filter({ visible: true }).first(),
  ).catch(() => false);
  // NOTE: prior code clicked a random feed post here as part of "browse",
  // then navigated AWAY from the feed back to a target post via goto(),
  // which lost SPA state. Now we stay on the feed; the comment phase
  // picks from visible feed posts and SPA-clicks directly.
  console.log(`[browse] done — staying on r/${SUBREDDIT}/${listingSort} feed for comment-phase post pick`);

  // ===== COMMENT — pick post from RENDERED FEED DOM =====
  // The 2026-05-01 instrumentation diff (zaneyates3333 run) revealed:
  //   - Feed page (/new): 33x faceplate-hovercard:open, good-visit signals
  //   - Browse-clicked post (1s9n1d2 via humanClickLocator): 34x hovercard
  //   - goto()-loaded post (1t0gnbv): only 2x hovercard listeners, no
  //     after-show/hide subscribers
  // The SPA-transition click loads the full hovercard component graph;
  // a cold goto load doesn't. Therefore we MUST pick a post that's actually
  // rendered in the feed DOM and click it, not pick from JSON API listing
  // and goto().
  //
  // shreddit-post elements expose the data we need as attributes:
  //   permalink, post-title, post-author, content-href, num-comments
  // Scrape these from the rendered feed, prefer text posts (those with
  // shreddit-post-text-body or selftext attribute), pick one randomly.
  const visiblePosts = await s.page.evaluate(() => {
    const out = [];
    const els = Array.from(document.querySelectorAll('shreddit-post'));
    for (const el of els) {
      const rect = el.getBoundingClientRect();
      // Only include posts within or near the viewport (humans see them).
      if (rect.bottom < 0 || rect.top > window.innerHeight + 800) continue;
      const permalink = el.getAttribute('permalink') || '';
      const title = el.getAttribute('post-title') || '';
      const numComments = parseInt(el.getAttribute('comment-count') || '0', 10);
      const isLocked = el.hasAttribute('is-locked');
      const isNsfw = el.hasAttribute('nsfw');
      // text post detection — has a post-title link AND no embedded media
      const hasText = !!el.querySelector('shreddit-post-text-body, [slot="text-body"], div[id^="t3_"][id$="-post-rtjson-content"]');
      if (!permalink || isLocked || isNsfw || numComments > 2000) continue;
      out.push({ permalink, title, numComments, hasText, top: rect.top });
    }
    return out;
  }).catch(() => []);
  console.log(`[feed-scrape] visible posts: ${visiblePosts.length}`);
  let postUrlWww = null, postTitle = '', postBody = '';
  if (visiblePosts.length) {
    // Prefer text posts; otherwise any visible post.
    const textPosts = visiblePosts.filter(p => p.hasText);
    const pool = textPosts.length ? textPosts : visiblePosts;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    postUrlWww = `https://www.reddit.com${pick.permalink}`;
    postTitle = pick.title;
    console.log(`[comment] picked from feed DOM: ${postTitle.slice(0, 60)}`);
    // Scrape selftext from the rendered feed DOM — NOT from .json API.
    // page.evaluate(fetch(.json)) is a bot signal: no human user ever
    // fetches raw JSON from the browser. Read the visible post body text
    // from the shreddit-post element instead.
    try {
      const body = await s.page.evaluate((perm) => {
        const el = document.querySelector(`shreddit-post[permalink="${perm}"]`);
        if (!el) return '';
        const textEl = el.querySelector('shreddit-post-text-body, [slot="text-body"], div[id^="t3_"][id$="-post-rtjson-content"]');
        return textEl?.textContent?.trim() || '';
      }, pick.permalink);
      postBody = body || '';
    } catch {}
  }
  if (!postUrlWww) throw new Error(`no eligible post visible in r/${SUBREDDIT} feed DOM`);
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

  let createdComment = null;

  if (SUBMIT_PATH === 'new') {
    // ===== NEW-reddit submit path =====
    // Use the real shreddit-composer UI on www.reddit.com. The visible
    // submit control is currently a custom button-small[type=submit], not
    // always a native <button>, so tagName === 'BUTTON' misses it and falls
    // back to unreliable Ctrl+Enter.
    //
    // Diagnostic listeners — without these the only signal on a renderer
    // crash or a forced page close is the catch-all
    // `[chromium:disconnected] pwBrowser disconnected pid=undefined` from
    // async_api.ts, which doesn't say which step the page died on.
    s.page.on('crash', () => console.log('[diag] page.crash fired'));
    s.page.on('close', () => console.log(`[diag] page.close fired url=${(() => { try { return s.page.url(); } catch { return 'n/a'; }})()}`));
    s.page.on('framenavigated', (f) => { if (f === s.page.mainFrame()) console.log(`[diag] framenavigated url=${f.url()}`); });
    s.page.on('pageerror', (e) => console.log(`[diag] pageerror ${String(e.message || e).slice(0, 200)}`));
    s.page.context().on('close', () => console.log('[diag] context.close fired'));
    // CRITICAL: navigate to the post by CLICKING from the feed page instead
    // of goto(). The human-handoff diff (2026-05-01) showed the human's
    // post page had rpl-hovercard:after-show/hide and rpl-dropdown:after-
    // show/hide listeners (146 hovercard listeners total), but the goto
    // path's post page only registered rpl-hovercard:show (43 listeners)
    // — the SPA transition from feed preserves the feed's JavaScript
    // state (good-visit telemetry, hovercard/dropdown component listeners)
    // while goto() does a cold page load that starts from scratch.
    const currentUrl = s.page.url();
    const alreadyOnPost = currentUrl.includes('/comments/') && currentUrl.includes(postUrlWww.split('/comments/')[1]?.split('/')[0] || '');
    if (!alreadyOnPost) {
      // Try clicking the post link from the feed. Fall back to goto if
      // the feed doesn't show this specific post (different sort, etc.).
      const postLink = s.page.locator(`a[href*="${postUrlWww.replace('https://www.reddit.com', '')}"]`).filter({ visible: true }).first();
      if (await postLink.count()) {
        console.log(`[comment] clicking post link from feed (SPA transition)`);
        await humanClickLocator(s.page, postLink);
        await s.page.waitForTimeout(3000 + Math.floor(Math.random() * 2000));
      } else {
        // Post link not visible in current feed (rare since we picked from
        // visible DOM). Scroll deeper to surface it.
        console.log(`[comment] post link not immediately visible — scrolling feed`);
        await humanScroll(s.page, 800 + Math.floor(Math.random() * 600), 2);
        await s.page.waitForTimeout(2000);
        const postLink2 = s.page.locator(`a[href*="${postUrlWww.replace('https://www.reddit.com', '')}"]`).filter({ visible: true }).first();
        if (await postLink2.count()) {
          console.log(`[comment] clicking post link after scroll (SPA transition)`);
          await humanClickLocator(s.page, postLink2);
          await s.page.waitForTimeout(3000 + Math.floor(Math.random() * 2000));
        } else {
          console.log(`[comment] post not in feed — falling back to goto (cold load — degraded path)`);
          await s.page.goto(postUrlWww, { waitUntil: 'domcontentloaded' });
        }
      }
    } else {
      console.log(`[comment] already on target post page`);
    }
    // Long initial dwell so Performance.getEntriesByType:mark milestones
    // complete — the human-handoff run accessed these (only-in-A); the prior
    // trajectory navigated/scrolled before they fired and Reddit's anti-spam
    // saw a "no good visit" signal (Storage.setItem:good-visit-feeds-search
    // never triggered in the trajectory, did in the handoff).
    await humanIdlePause('deliberate');
    // Long initial dwell so Reddit's full SPA boots:
    //   - chat:matrix-* infrastructure (only-in-H in 2026-05-01 diff)
    //   - lit-router-connected, rs-auth-client-user-change
    //   - UserStoreById/ByName, redirect-account-manager
    //   - faceplate-tracker components (which mount the hovercard system)
    // The human-handoff session dwelled minutes on the post page; the
    // prior trajectory's 5-8s waitForTimeout submitted before async
    // boot completed. Reddit's anti-spam reads this "no chat init,
    // no faceplate hovercard subscribers" as a low-trust profile and
    // shadow-removes the comment.
    await s.page.waitForTimeout(15000 + Math.floor(Math.random() * 10000));

    // Hover post-author username — wait for the hovercard popover to
    // actually mount (rpl-hovercard:after-show fires when popover is
    // visible). Use a longer dwell so the popover has time to render.
    // Property-trap diff (handoff vs trajectory 2026-05-01) showed
    // rpl-hovercard:after-show was only-in-H; rpl-hovercard:show was
    // only-in-T — meaning we registered the listener but the popover
    // never displayed. A 1.5-3.3s hover wasn't long enough.
    const hovered1 = await humanHoverDwell(
      s.page,
      s.page.locator('a[href^="/user/"]').filter({ visible: true }).first(),
      { minMs: 3500, maxMs: 6500 },
    ).catch(() => false);
    console.log(`[hover] post-author dwell ${hovered1 ? 'fired' : 'skipped'}`);

    // Natural reading scroll — exposes commenter usernames.
    await humanScroll(s.page, 800 + Math.floor(Math.random() * 600), 3);
    await s.page.waitForTimeout(3000 + Math.floor(Math.random() * 2000));

    // Hover ANOTHER username (a commenter, after the post-author).
    // Human had 2x rpl-hovercard:after-show in the diff — they hovered
    // two distinct username links.
    const userLinks = await s.page.locator('a[href^="/user/"]').filter({ visible: true }).all().catch(() => []);
    if (userLinks.length > 1) {
      const hovered2 = await humanHoverDwell(
        s.page,
        userLinks[1],
        { minMs: 2500, maxMs: 4500 },
      ).catch(() => false);
      console.log(`[hover] commenter dwell ${hovered2 ? 'fired' : 'skipped'}`);
    }
    await s.page.waitForTimeout(3000 + Math.floor(Math.random() * 2000));

    const postUrl = s.page.url();
    console.log(`[comment] post-page url=${postUrl}`);
    if (/\/login/.test(postUrl)) throw new Error(`comment phase: redirected to login (cookies invalid)`);

    const findComposerPart = (part) => {
      function dig(root, predicate) {
        const queue = [root];
        while (queue.length) {
          const node = queue.shift();
          if (!node) continue;
          if (node.nodeType === Node.ELEMENT_NODE && predicate(node)) return node;
          if (node.shadowRoot) queue.push(node.shadowRoot);
          if (node.children) queue.push(...node.children);
        }
        return null;
      }
      const composers = Array.from(document.querySelectorAll('shreddit-composer'));
      const composer = composers.find((sc) => {
        const r = sc.getBoundingClientRect();
        return r.width > 20 && r.height > 20;
      }) || composers[0];
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 8 && r.height > 8 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const visibleFaceplate = () => {
        const inputs = Array.from(document.querySelectorAll('faceplate-textarea-input[placeholder="Join the conversation"]'));
        const el = inputs.find(isVisible);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          x: r.left + Math.min(40, r.width / 2),
          y: r.top + Math.min(22, r.height / 2),
          w: r.width,
          h: r.height,
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || el.getAttribute('placeholder') || '').trim().slice(0, 80),
        };
      };
      if (part === 'editable') {
        if (!composer) return null;
        // Dig from composer (host element) so the traversal covers both
        // composer.shadowRoot AND composer.children (light DOM / slotted).
        // Reddit's shreddit-composer keeps the contenteditable in the
        // light DOM after expansion; searching only shadowRoot misses it.
        const el = dig(composer, (e) => {
          if (!isVisible(e)) return false;
          if (e.getAttribute('contenteditable') === 'true') return true;
          if (e.matches?.('[role="textbox"], textarea')) return true;
          return false;
        });
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + Math.min(40, r.width / 2), y: r.top + Math.min(24, r.height / 2), w: r.width, h: r.height, tag: el.tagName.toLowerCase() };
      }
      if (part === 'placeholder') {
        const fp = visibleFaceplate();
        if (fp) return fp;
        if (!composer) return null;
        const el = dig(composer, (e) => {
          if (!isVisible(e)) return false;
          const text = (e.textContent || '').trim().toLowerCase();
          if (e.classList?.contains('cursor-text')) return true;
          if (text.includes('join the conversation')) return true;
          return false;
        }) || composer;
        const r = el.getBoundingClientRect();
        return { x: r.left + Math.min(44, r.width / 2), y: r.top + Math.min(24, r.height / 2), w: r.width, h: r.height, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 80) };
      }
      if (!composer) return null;
      // Dig from composer (host) so traversal covers BOTH composer.shadowRoot
      // and composer.children (light DOM). The Comment submit button is
      // rendered in the light DOM as `<button type="submit">comment</button>`
      // — it's not inside shadowRoot, so the prior `composer.shadowRoot ??
      // composer` form was missing it whenever shadowRoot existed.
      const el = dig(composer, (e) => {
        if (!isVisible(e)) return false;
        const tag = e.tagName.toLowerCase();
        const type = (e.getAttribute('type') || '').toLowerCase();
        if (type !== 'submit' && !tag.includes('button')) return false;
        const text = (e.textContent || e.getAttribute('aria-label') || '').trim().toLowerCase();
        if (!text.includes('comment') && !text.includes('reply') && !text.includes('submit')) return false;
        if (e.disabled || e.getAttribute('aria-disabled') === 'true') return false;
        return true;
      });
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 80) };
    };

    // Pre-flight: scroll the composer into view BEFORE doing any clicks.
    // After humanScroll() the composer can be at y<0 (above viewport) or
    // y>viewportH (below viewport). CDP Input.dispatchMouseEvent at a
    // negative or out-of-viewport Y silently drops the CDP session —
    // Chromium does not crash, the renderer rejects the event and
    // Playwright surfaces it as `pwBrowser disconnected`. Diagnosed
    // 2026-04-30 via [diag] log of zanestone7384 run (y=-337) and
    // sagekoepp1273 run (y=-535).
    const viewportH = await s.page.evaluate(() => window.innerHeight).catch(() => 1440);
    // Scroll the composer into view via locator API, not page.evaluate(
    // scrollIntoView) — the JS scrollIntoView({behavior:'instant'}) produces
    // no wheel events and is a bot signal. The locator method also uses
    // instant scroll but doesn't run visible JS in the page context.
    const composerLocator = s.page.locator('shreddit-composer').first();
    await composerLocator.scrollIntoViewIfNeeded().catch(() => {});
    await humanIdlePause('short');

    let editable = null;
    for (let i = 0; i < 6; i++) {
      editable = await s.page.evaluate(findComposerPart, 'editable').catch(() => null);
      if (editable && editable.y >= 0 && editable.y <= viewportH) break;
      editable = null;
      const placeholder = await s.page.evaluate(findComposerPart, 'placeholder').catch(() => null);
      if (placeholder && placeholder.y >= 0 && placeholder.y <= viewportH) {
        // Click the placeholder ONCE to expand the composer. Do NOT click
        // again outside the loop — a second click toggles the composer
        // back to collapsed, which is why the submit-button probe was
        // returning null in the sagekoepp1273 run.
        console.log(`[diag] clicking placeholder at (${placeholder.x}, ${placeholder.y})`);
        await humanClick(s.page, placeholder.x, placeholder.y);
        await s.page.waitForTimeout(1500);
        // Re-probe — after expansion the contenteditable should exist.
        const expanded = await s.page.evaluate(findComposerPart, 'editable').catch(() => null);
        if (expanded && expanded.y >= 0 && expanded.y <= viewportH) {
          editable = expanded;
          console.log(`[comment] composer expanded → editable: ${JSON.stringify(editable)}`);
          break;
        }
        // Composer didn't expand to a contenteditable. Reuse the placeholder
        // position — typing will hit whatever is now focused (clicking the
        // faceplate moves focus to its internal textarea).
        editable = placeholder;
        console.log(`[comment] composer didn't expose editable; using placeholder pos: ${JSON.stringify(editable)}`);
        break;
      }
      // Removed: dispatchEvent('open-comment-composer') — no human ever
      // dispatches custom DOM events; it's a bot signal. The placeholder
      // click above handles composer expansion.
      await humanIdlePause('deliberate');
    }
    console.log(`[comment] new-reddit editable probe: ${JSON.stringify(editable)}`);
    if (!editable) throw new Error('new-reddit composer editable not found');

    // Type into whatever element is now focused after the placeholder click.
    // No second click — that would toggle the composer back to collapsed.
    console.log(`[diag] before humanType len=${COMMENT_BODY.length}`);
    await humanType(s.page, COMMENT_BODY);
    console.log(`[diag] after humanType — url=${s.page.url()} closed=${s.page.isClosed()}`);

    // Diagnostic: confirm the body landed somewhere in the DOM. If this
    // is false, the typing went to a non-focused or wrong target and the
    // submit button won't appear.
    const bodyLanded = await s.page.evaluate((needle) => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const want = norm(needle).slice(0, 50);
      if (!want) return false;
      // Check page body innerText (covers contenteditable + textarea values
      // through faceplate web components).
      if (norm(document.body.innerText).includes(want)) return true;
      // Check shreddit-composer shadow DOM contenteditable + textarea.
      for (const sc of document.querySelectorAll('shreddit-composer')) {
        const root = sc.shadowRoot ?? sc;
        const queue = [root];
        while (queue.length) {
          const n = queue.shift();
          if (!n) continue;
          if (n.nodeType === Node.ELEMENT_NODE) {
            if (norm(n.textContent).includes(want)) return true;
            if (typeof n.value === 'string' && norm(n.value).includes(want)) return true;
            if (n.shadowRoot) queue.push(n.shadowRoot);
            if (n.children) queue.push(...n.children);
          }
        }
      }
      return false;
    }, COMMENT_BODY).catch(() => false);
    console.log(`[diag] body-landed-in-dom=${bodyLanded}`);

    await humanIdlePause('short');
    await vpJitter();
    console.log(`[diag] after vpJitter — about to probe submit`);

    let submit = null;
    for (let i = 0; i < 8; i++) {
      submit = await s.page.evaluate(findComposerPart, 'submit').catch(() => null);
      if (submit) break;
      await s.page.waitForTimeout(750);
    }
    console.log(`[comment] new-reddit submit probe: ${JSON.stringify(submit)}`);
    if (!submit) {
      // Diagnostic: dump ALL button-like elements with comment/reply/submit
      // text anywhere on the page so we can see what the structure actually
      // looks like after typing on a fresh account.
      const enumeration = await s.page.evaluate(() => {
        const out = [];
        const seen = new Set();
        function isVis(el) {
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return r.width > 4 && r.height > 4 && st.visibility !== 'hidden' && st.display !== 'none';
        }
        function visit(root, depth) {
          if (!root || depth > 12 || seen.has(root)) return;
          seen.add(root);
          const queue = [root];
          while (queue.length) {
            const n = queue.shift();
            if (!n || n.nodeType !== 1) continue;
            const tag = n.tagName.toLowerCase();
            const type = (n.getAttribute?.('type') || '').toLowerCase();
            const role = (n.getAttribute?.('role') || '').toLowerCase();
            const text = (n.textContent || '').trim().toLowerCase().slice(0, 60);
            const aria = (n.getAttribute?.('aria-label') || '').toLowerCase();
            const matches = (tag.includes('button') || type === 'submit' || role === 'button')
              && (text.includes('comment') || text.includes('reply') || text.includes('submit') || text.includes('post')
                  || aria.includes('comment') || aria.includes('reply') || aria.includes('submit') || aria.includes('post'));
            if (matches) {
              const r = n.getBoundingClientRect();
              out.push({
                tag, type, role,
                text: text.slice(0, 40),
                aria: aria.slice(0, 40),
                vis: isVis(n),
                disabled: !!n.disabled || n.getAttribute?.('aria-disabled') === 'true',
                x: Math.round(r.left + r.width / 2),
                y: Math.round(r.top + r.height / 2),
                w: Math.round(r.width),
                h: Math.round(r.height),
              });
            }
            if (n.shadowRoot) queue.push(n.shadowRoot);
            if (n.children) queue.push(...n.children);
          }
        }
        visit(document.documentElement, 0);
        return out.slice(0, 30);
      }).catch((e) => ({ err: String(e) }));
      console.log(`[diag] all-button-like enumeration: ${JSON.stringify(enumeration)}`);
      // Dump composer state too
      const composerState = await s.page.evaluate(() => {
        const out = [];
        for (const sc of document.querySelectorAll('shreddit-composer')) {
          const r = sc.getBoundingClientRect();
          out.push({
            w: Math.round(r.width), h: Math.round(r.height),
            hasShadow: !!sc.shadowRoot,
            childCount: sc.children?.length ?? 0,
            shadowChildCount: sc.shadowRoot?.children?.length ?? 0,
            innerHTMLLen: (sc.innerHTML || '').length,
            shadowHTMLLen: (sc.shadowRoot?.innerHTML || '').length,
          });
        }
        return out;
      }).catch(() => null);
      console.log(`[diag] composer-state: ${JSON.stringify(composerState)}`);
      throw new Error('new-reddit composer submit button not found');
    }

    await humanClick(s.page, submit.x, submit.y);
    console.log('[comment] submitted via new-reddit shreddit-composer submit button');

    // New-reddit does not submit through old /api/comment XHR. It posts to
    // /svc/shreddit/t3_<post>/create-comment and returns a partial HTML
    // payload containing the newly-created <shreddit-comment> with thingId
    // and permalink. This is the earliest authoritative submit-success
    // signal; user listing can lag and caused false negatives in tests.
    for (let i = 0; i < 12; i++) {
      await s.page.waitForTimeout(1000);
      const fromResponse = [...s.capturedResponses]
        .reverse()
        .filter(r => r.status >= 200 && r.status < 300 && /\/svc\/shreddit\/t3_[a-z0-9]+\/create-comment/i.test(r.url))
        .map(r => extractCommentFromCreateResponse(r.body, COMMENT_BODY))
        .find(Boolean);
      if (fromResponse) {
        createdComment = fromResponse;
        break;
      }
      const fromDom = await s.page.evaluate((body) => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const needle = norm(body).slice(0, 80);
        for (const el of document.querySelectorAll('shreddit-comment')) {
          const text = norm(el.textContent);
          if (needle && !text.includes(needle)) continue;
          const permalink = el.getAttribute('permalink') || '';
          const thingId = el.getAttribute('thingid') || el.getAttribute('thingId') || '';
          const id = (thingId.match(/^t1_([a-z0-9]+)$/i) || [])[1] || '';
          const linkId = (permalink.match(/\/comments\/([a-z0-9]+)\//i) || [])[1] || '';
          if (permalink || id) return { permalink, id, linkId };
        }
        return null;
      }, COMMENT_BODY).catch(() => null);
      if (fromDom) {
        createdComment = fromDom;
        break;
      }
    }
    console.log(`[comment] new-reddit created-comment probe: ${JSON.stringify(createdComment)}`);
  } else {
    // ===== OLD-reddit submit path (default, proven-working) =====
    const oldRedditUrl = postUrlWww.replace(/^https?:\/\/(www\.|new\.)?reddit\.com/, 'https://old.reddit.com');
    await s.page.goto(oldRedditUrl, { waitUntil: 'domcontentloaded' });
    await humanIdlePause('deliberate');
    await s.page.waitForTimeout(2000 + Math.floor(Math.random() * 1500));

    const postUrl = s.page.url();
    console.log(`[comment] post-page url=${postUrl}`);
    if (/\/login/.test(postUrl)) throw new Error(`comment phase: redirected to login (cookies invalid)`);

    const probe = await s.page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('textarea'));
      const meta = all.map(t => ({
        name: t.name,
        visible: t.offsetParent !== null,
        rect: (() => { const r = t.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; })(),
        parent: t.parentElement?.className?.slice(0, 60),
        grand: t.parentElement?.parentElement?.className?.slice(0, 60),
      }));
      return { textareas: meta, hasForm: !!document.querySelector('form.usertext'), title: document.title };
    });
    console.log(`[comment] probe: ${JSON.stringify(probe).slice(0, 600)}`);

    const textarea = s.page.locator('textarea[name="text"]').first();
    await textarea.waitFor({ state: 'visible', timeout: 15000 });
    await humanClickLocator(s.page, textarea);
    await humanIdlePause('short');
    await humanType(s.page, COMMENT_BODY);
    await humanIdlePause('short');
    await vpJitter();
    // CRITICAL: scope the submit button to the SAME form as the textarea
    // (existing thread-comments have their own .save controls that post
    // to absolute www.reddit.com/api/comment, going through new-reddit's
    // spam filter — always shadow_removed for new accounts).
    const submitBtn = textarea.locator('xpath=ancestor::form[1]').locator('button.save, button[type="submit"]').first();
    await submitBtn.waitFor({ state: 'visible', timeout: 10000 });
    await humanClickLocator(s.page, submitBtn);
    console.log('[comment] submitted via form-scoped submit button (OLD-reddit)');
  }

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

  // Sample handle from /api/me.json via Playwright request context (NOT
  // page.evaluate(fetch(...)) — that is a bot signal: no human user ever
  // fetches JSON API from in-page JS). Use the context's request which
  // inherits session cookies + proxy.
  let realHandle = null;
  try {
    const meResp = await s.page.context().request.get('https://www.reddit.com/api/me.json', { headers: { 'Accept': 'application/json' }, ignoreHTTPSErrors: true, timeout: 10000 }).catch(() => null);
    if (meResp) {
      const meData = await meResp.json().catch(() => null);
      realHandle = meData?.data?.name ?? null;
    }
  } catch {}
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
  const acceptedBySubmit = !!(createdComment?.permalink || createdComment?.id);
  if (createdComment) {
    commentPermalink = createdComment.permalink
      ? (createdComment.permalink.startsWith('/') ? createdComment.permalink : `/${createdComment.permalink}`)
      : '';
    commentLinkId = createdComment.linkId || '';
    commentId = createdComment.id || '';
  }

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
    // Use context().request (not page.evaluate(fetch)) — same reasoning as
    // /api/me.json above: in-page fetch of .json URLs is a bot signal.
    try {
      const authResp = await s.page.context().request.get(`https://www.reddit.com/user/${encodeURIComponent(realHandle)}/comments/.json?limit=15&sort=new`, { headers: { 'Accept': 'application/json' }, ignoreHTTPSErrors: true, timeout: 15000 }).catch(() => null);
      if (authResp) {
        const authData = await authResp.json().catch(() => null);
        inAuthListing = (authData?.data?.children ?? []).some((c) => typeof c?.data?.body === 'string' && c.data.body.includes(COMMENT_BODY));
      }
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

  console.log(`[verify] acceptedBySubmit=${acceptedBySubmit} inUserListing=${inUserListing} inPostThread=${inPostThread} aboutStatus=${publicAboutStatus} inAuthListing=${inAuthListing} permalink=${commentPermalink}`);

  let verdict;
  const accepted = acceptedBySubmit || inUserListing || inAuthListing;
  if (publicAboutStatus === 404) verdict = 'shadowbanned';
  else if (inPostThread && accepted) verdict = 'PASS';
  else if (accepted && !inPostThread) verdict = 'shadow_removed';
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
