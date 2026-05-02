import { WSession } from '../../dist/session/wsession.js';
import { humanType } from '../../dist/human/keyboard.js';
import { humanMove, humanIdlePause, humanClick, humanClickLocator, humanScroll, humanHoverDwell } from '../../dist/human/mouse.js';
import { findComposerPart, spaTransitionToPost, engageMedia, dwellOnPostPage, submitNewRedditComment, verifyCommentVisibility, postSubmitBrowse } from './reddit/actions/comment_new.mjs';
import { detectRedditBanSignals } from '../../dist/platforms/reddit/ban_signals.js';
import { generateOrganicComment } from './_shared/llm.mjs';
import { randomBytes } from 'node:crypto';
process.on('unhandledRejection', (err) => { console.log(`UNHANDLED: ${err?.message || err}`); process.exit(2); });
process.on('uncaughtException', (err) => { console.log(`UNCAUGHT: ${err?.message || err}`); process.exit(3); });
const REGISTER_URL = 'https://www.reddit.com/register';
const NEWBIE_FRIENDLY_SUBS = [
  'CasualConversation', 'AskOldPeople', 'AskReddit', 'NoStupidQuestions',
  'mildlyinteresting', 'todayilearned', 'AskMen', 'AskWomen',
];
const RAW_SUBREDDIT = process.env.SUBREDDIT || 'popular';
const SUBREDDIT = (RAW_SUBREDDIT === 'popular' || RAW_SUBREDDIT === 'all')
  ? NEWBIE_FRIENDLY_SUBS[Math.floor(Math.random() * NEWBIE_FRIENDLY_SUBS.length)]
  : RAW_SUBREDDIT;
const COMMENT_BODY_OVERRIDE = process.env.COMMENT_BODY || null;
// 2026-05-02: default flipped to 'new' (modern shreddit composer) after diff harness
// proved the legacy old.reddit /api/comment XHR submit was the shadowban discriminator.
// Survived handoff (human, www.reddit.com): Fetch.POST:/svc/shreddit/t3_<id>/create-comment?cujTrackingId=...
// Removed trajectory  (auto, old.reddit.com): XHR.POST:/api/comment   (no cujTrackingId)
// Plus only-A modern composer event subs (comment-post, comment-composer-cancel-draft,
// rte-*, open-comment-composer), only-A Storage:comment-draft-items-*, only-A
// Storage:rc::d-* recaptcha tokens; only-B legacy anti-bot Function.toString probes
// (querySelectorAll/matches/eval/compareDocumentPosition) and only-B XHR /api/comment,
// /api/badge_indicators/v1, /api/share. Reddit's fresh-account spam classifier flags
// "first comment via legacy old.reddit interface" because real new users land on the
// modern site. Set SUBMIT_PATH=old to opt back into the legacy path for A/B comparison.
const SUBMIT_PATH = (process.env.SUBMIT_PATH === 'old' || process.env.OLD_REDDIT === '1') ? 'old' : 'new';
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
  const beforeVal = await userIn.inputValue().catch(() => '?');
  console.log(`[register] username field BEFORE typing: "${beforeVal}"`);
  await humanClickLocator(s.page, userIn);
  for (let attempt = 0; attempt < 3; attempt++) {
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
  await humanIdlePause('deliberate');
  await s.page.waitForTimeout(3000 + Math.floor(Math.random() * 4000));
  console.log('[browse] organic session before comment');
  const listingSort = 'new';
  const feedUrl = SUBREDDIT === 'popular' || SUBREDDIT === 'all'
    ? 'https://www.reddit.com/'
    : `https://www.reddit.com/r/${SUBREDDIT}/`;
  await s.page.goto(feedUrl, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');
  await s.page.waitForTimeout(15000 + Math.floor(Math.random() * 10000));
  await humanScroll(s.page, 1200 + Math.floor(Math.random() * 800), 3 + Math.floor(Math.random() * 3));
  await humanIdlePause('deliberate');
  await humanHoverDwell(
    s.page,
    s.page.locator('a[href^="/user/"], a[href*="/user/"]').filter({ visible: true }).first(),
  ).catch(() => false);
  await s.page.waitForTimeout(8000 + Math.floor(Math.random() * 6000));
  await humanScroll(s.page, 1000 + Math.floor(Math.random() * 600), 2 + Math.floor(Math.random() * 2));
  await humanIdlePause('deliberate');
  const feedUserLinks = await s.page.locator('a[href^="/user/"], a[href*="/user/"]').filter({ visible: true }).all().catch(() => []);
  if (feedUserLinks.length > 1) {
    await humanHoverDwell(s.page, feedUserLinks[1]).catch(() => false);
  }
  await humanIdlePause('deliberate');
  console.log(`[browse] done — staying on r/${SUBREDDIT}/${listingSort} feed for comment-phase post pick`);

  // ===== COMMENT — pick post from RENDERED FEED DOM =====
  const visiblePosts = await s.page.evaluate(() => {
    const out = [];
    const els = Array.from(document.querySelectorAll('shreddit-post'));
    for (const el of els) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight + 800) continue;
      const permalink = el.getAttribute('permalink') || '';
      const title = el.getAttribute('post-title') || '';
      const numComments = parseInt(el.getAttribute('comment-count') || '0', 10);
      const isLocked = el.hasAttribute('is-locked');
      const isNsfw = el.hasAttribute('nsfw');
      const hasMedia = !!el.querySelector('shreddit-player, video, iframe[src*="youtube"], iframe[src*="youtu.be"], img.gallery-carousel-image, shreddit-gallery-carousel, a[href*="imgur"], a[href*=".jpg"], a[href*=".png"], a[href*=".gif"], shreddit-aspect-ratio-box img');
      const hasText = !!el.querySelector('shreddit-post-text-body, [slot="text-body"], div[id^="t3_"][id$="-post-rtjson-content"]');
      if (!permalink || isLocked || isNsfw || numComments > 2000) continue;
      out.push({ permalink, title, numComments, hasMedia, hasText, top: rect.top });
    }
    return out;
  }).catch(() => []);
  console.log(`[feed-scrape] visible posts: ${visiblePosts.length}`);
  let postUrlWww = null, postTitle = '', postBody = '', postHasMedia = false;
  if (visiblePosts.length) {
    const mediaPosts = visiblePosts.filter(p => p.hasMedia);
    const textPosts = visiblePosts.filter(p => p.hasText && !p.hasMedia);
    const pool = mediaPosts.length ? mediaPosts : textPosts.length ? textPosts : visiblePosts;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    postUrlWww = `https://www.reddit.com${pick.permalink}`;
    postTitle = pick.title;
  postHasMedia = pick.hasMedia;
    console.log(`[comment] picked from feed DOM: ${postTitle.slice(0, 60)} ${postHasMedia ? '(media)' : '(text)'}`);
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
    s.page.on('crash', () => console.log('[diag] page.crash fired'));
    s.page.on('close', () => console.log(`[diag] page.close fired url=${(() => { try { return s.page.url(); } catch { return 'n/a'; }})()}`));
    s.page.on('framenavigated', (f) => { if (f === s.page.mainFrame()) console.log(`[diag] framenavigated url=${f.url()}`); });
    s.page.on('pageerror', (e) => console.log(`[diag] pageerror ${String(e.message || e).slice(0, 200)}`));
    s.page.context().on('close', () => console.log('[diag] context.close fired'));
    await spaTransitionToPost(s.page, postUrlWww);
    if (postHasMedia) await engageMedia(s.page);
    await dwellOnPostPage(s.page);
    const postUrl = s.page.url();
    console.log(`[comment] post-page url=${postUrl}`);
    if (/\/login/.test(postUrl)) throw new Error(`comment phase: redirected to login (cookies invalid)`);
    createdComment = await submitNewRedditComment(
      s.page, COMMENT_BODY, s.capturedResponses, extractCommentFromCreateResponse,
    );
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
    const submitBtn = textarea.locator('xpath=ancestor::form[1]').locator('button.save, button[type="submit"]').first();
    await submitBtn.waitFor({ state: 'visible', timeout: 10000 });
    await humanClickLocator(s.page, submitBtn);
    console.log('[comment] submitted via form-scoped submit button (OLD-reddit)');
  }
  let postedLocally = false;
  for (let i = 0; i < 12; i++) {
    await s.page.waitForTimeout(1500);
    const txt = await s.page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    if (txt.includes(COMMENT_BODY)) { postedLocally = true; break; }
  }
  console.log(`[comment] in-page check: ${postedLocally ? 'visible' : 'not seen yet (proceeding to verify)'}`);
  let realHandle = null;
  try {
    const meResp = await s.page.context().request.get('https://www.reddit.com/api/me.json', { headers: { 'Accept': 'application/json' }, ignoreHTTPSErrors: true, timeout: 10000 }).catch(() => null);
    if (meResp) { const meData = await meResp.json().catch(() => null); realHandle = meData?.data?.name ?? null; }
  } catch {}
  console.log(`[comment] real handle: ${realHandle}`);
  const commentPermalink = createdComment?.permalink ? (createdComment.permalink.startsWith('/') ? createdComment.permalink : `/${createdComment.permalink}`) : '';
  const { inUserListing, inPostThread, publicAboutStatus: aboutStatus, inAuthListing, verdict } = await verifyCommentVisibility(s.page, {
    realHandle, commentBody: COMMENT_BODY, commentPermalink, proxyConfig: s.proxyConfig,
  });
  const acceptedBySubmit = !!(createdComment?.permalink || createdComment?.id);
  if (verdict === 'PASS') {
    console.log(`PASS: ${id.username} -> commented "${COMMENT_BODY}" -> https://www.reddit.com${commentPermalink} (visible in post thread)`);
    await postSubmitBrowse(s.page);
  } else {
    console.log(`FAIL: ${id.username} -> ${verdict} | inUserListing=${inUserListing} inPostThread=${inPostThread} aboutStatus=${aboutStatus} inAuthListing=${inAuthListing}`);
    process.exit(1);
  }
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 300));
  process.exit(1);
} finally {
  await s.close();
}