import { getSocialAccount, resolveAccountSession } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { detectRedditBanSignals } from '../../dist/platforms/reddit/ban_signals.js';
import { humanType } from '../../dist/human/keyboard.js';
import { humanIdlePause, humanScroll, humanClickLocator } from '../../dist/human/mouse.js';
import { probeCommentVisibility, probeShadowban } from '../../dist/platforms/reddit/shadowban_probe.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Use old.reddit.com — comment composer is a plain visible <textarea name="text">
// inside a normal form. New reddit.com puts the composer inside <shreddit-composer>'s
// shadow root collapsed at 0×0 until the user clicks "Join the conversation",
// which the agent loop never reliably finds and times out at max-iterations.
//
// Default target: r/CasualConversation (newbie-tolerant, no karma gate, light
// AutoMod). Previous default r/test produced false-positive shadowban verdicts:
// r/test's auto-mod removes new-account comments quickly, which our verifier
// reads as shadowban. CasualConversation accepts comments from <24h-old
// accounts and has steady comment volume.
const TARGET_URL = process.env.TARGET_URL || 'https://www.reddit.com/r/CasualConversation/new/';

// Deferred clean-session verify: see organic_comment.mjs for rationale.
// Wait this long after submit confirms in our own session, then re-check the
// comment's public visibility from a fresh proxy + no cookies. Set to 0 to
// disable (legacy behaviour for tests).
const DEFER_VERIFY_MS = Number(process.env.DEFER_VERIFY_MS ?? 300_000);
// Comment body needs to be innocuous and topic-appropriate. The previous
// default "Hello from weles agent" literally announced automation —
// Reddit's content classifier flags this and shadowbans the account
// within minutes of submit. For the test/r/test post (a sandbox subreddit
// where commenters explicitly try API calls), generic acknowledgement-style
// text is normal and won't flag.
const COMMENT_BODY = process.env.COMMENT_BODY || 'thanks for sharing';

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account in DB'); process.exit(1); }
console.log(`[trajectory] Using account: ${acct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'reddit_comment', proxy: proxyUrl, persona });

// Translate www.reddit.com URLs → old.reddit.com so we can use the plain form.
const oldUrl = TARGET_URL.replace(/^https?:\/\/(www\.)?reddit\.com/, 'https://old.reddit.com');

let banSignal = null;
try {
  // Restore full storage state (cookies + per-origin localStorage). The
  // localStorage half is critical: Reddit's web app writes anti-bot tokens
  // (loid, _id_secret, redditcmoreId, telemetry session id, eu_cookie_v2)
  // into localStorage on first load, then sends them as XHR headers
  // (x-reddit-loid etc.) on every subsequent action. Restoring ONLY cookies
  // means the comment XHR has session=valid but loid/telemetry=missing,
  // which Reddit's anti-bot tags as "session moved to different device" and
  // shadowbans the account within seconds. Old accounts (registered before
  // 2026-04-29) only have cookies stored — fall through to cookie-only
  // restore for those.
  const ss = acct.metadata?.storage_state;
  if (ss && Array.isArray(ss.cookies) && ss.cookies.length) {
    const valid = ss.cookies.filter(c => c.name && c.value && c.domain).map(c => ({ ...c, path: c.path || '/' }));
    if (valid.length) await s.ctx.addCookies(valid);
    // localStorage restoration: requires a document context per origin, so
    // visit each origin once with a no-network blank doc, then setItem.
    for (const o of ss.origins ?? []) {
      if (!o?.origin || !Array.isArray(o.localStorage) || !o.localStorage.length) continue;
      try {
        await s.page.goto(o.origin, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await s.page.evaluate((items) => {
          for (const it of items) { try { window.localStorage.setItem(it.name, it.value); } catch { /* skip */ } }
        }, o.localStorage);
      } catch (e) { console.log(`[trajectory] storage-state restore origin=${o.origin} skipped: ${e.message?.slice(0, 80)}`); }
    }
    console.log(`[trajectory] restored storage_state: ${valid.length} cookies + ${ss.origins?.reduce((n, o) => n + (o.localStorage?.length ?? 0), 0) ?? 0} localStorage entries across ${ss.origins?.length ?? 0} origin(s)`);
  } else {
    const stored = (acct.metadata?.cookies ?? []).filter(c => /reddit\.com/.test(c.domain ?? ''));
    if (stored.length) await s.ctx.addCookies(stored.map(c => ({ ...c, path: c.path || '/' })));
    console.log(`[trajectory] legacy account (no storage_state) — restored ${stored.length} cookies only. Account vulnerable to "session-on-new-device" detection.`);
  }
  // Pre-check: read our real handle so the post-submit verification can use
  // it. Previously this also probed about.json and bailed early on 404,
  // but the about.json 404 check has a documented false-positive history:
  // Reddit's edge tier returns 404 for about.json requests routed through
  // certain residential proxy IPs even when the account is healthy and
  // the comment becomes publicly visible. Verified 2026-04-29: zanewest5941
  // commented publicly-visible via reddit_register_then_comment.mjs (which
  // doesn't pre-check), then reddit_comment.mjs's pre-check declared the
  // same account shadowbanned via about.json 404 in the same minute.
  // The reliable shadowban signal is the post-submit permalink JSON check,
  // which uses the same fetch path as the comment submission. Skip the
  // early bail; rely on the post-submit visibility loop instead.
  await s.page.goto('https://old.reddit.com/api/me.json', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');
  const realHandle = await s.page.evaluate(() => { try { return JSON.parse(document.body?.innerText ?? '{}')?.data?.name ?? null; } catch { return null; } });
  if (realHandle) console.log(`[trajectory] real handle: ${realHandle}`);

  // If TARGET_URL points to a sub listing (no /comments/<id>/ segment), pick
  // a recent post from the sub via the JSON API. Lets the default URL be a
  // newbie-tolerant sub root rather than a specific post that may go stale.
  let resolvedOldUrl = oldUrl;
  if (!/\/comments\/[a-z0-9]+\//i.test(oldUrl)) {
    try {
      const listingSrc = oldUrl.endsWith('/') ? oldUrl : oldUrl + '/';
      const listingJson = listingSrc.replace(/\/$/, '/.json?limit=25');
      const data = await s.page.evaluate(async (u) => {
        const r = await fetch(u, { credentials: 'include' });
        if (!r.ok) return null;
        return await r.json();
      }, listingJson).catch(() => null);
      const candidates = (data?.data?.children ?? [])
        .map(c => c.data)
        .filter(p => p && !p.locked && !p.archived && (p.num_comments ?? 0) < 800);
      const pick = candidates[Math.floor(Math.random() * Math.min(candidates.length, 8))];
      if (pick?.permalink) resolvedOldUrl = `https://old.reddit.com${pick.permalink}`;
      console.log(`[trajectory] resolved sub listing -> post ${resolvedOldUrl}`);
    } catch (e) {
      console.log(`[trajectory] sub listing fetch err: ${e.message?.slice(0, 100)}`);
    }
  }

  await s.page.goto(resolvedOldUrl, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');
  const url = s.page.url();
  if (/\/login/.test(url)) { console.log(`FAIL: cookies stale, redirected to login (${url})`); process.exit(1); }

  // Pre-comment dwell — scroll the post body and a few existing comments
  // before opening the composer. Reddit's behavioral classifier scores the
  // user's pre-action telemetry as part of the post-submit shadowban gate.
  await humanIdlePause('deliberate');
  await humanScroll(s.page, 1200, 3).catch(() => {});
  await humanIdlePause('short');

  // The comment composer is the FIRST textarea[name="text"] on the page —
  // there's one per existing reply box but the top-level reply form is first.
  const ta = s.page.locator('textarea[name="text"]').filter({ visible: true }).first();
  await ta.waitFor({ state: 'visible' });
  // Humanized click into textarea — moves cursor via Bezier path, lands at
  // a randomized offset inside the box, then clicks. Replaces the prior
  // bare locator.click() (which still emitted real mouse events through
  // Playwright's input layer but with zero pre-click pointer trajectory —
  // a behavioral signal Reddit's anti-bot reads alongside the submit click).
  await humanClickLocator(s.page, ta);
  await humanIdlePause('short');
  await ta.focus();
  await humanType(s.page, COMMENT_BODY);
  await humanIdlePause('short');
  // CRITICAL: this submit click was previously a `page.evaluate(() =>
  // form.querySelector('button.save').click())` — a synthetic JS click that
  // produces ZERO mouse events on the page. Reddit's behavioral classifier
  // tracks pointermove/mouseenter/mouseover/pointerdown/mouseup/click as a
  // sequence; an action-submit click with no preceding pointer activity
  // and no real mousedown/mouseup is the textbook bot signal. Verified
  // 2026-04-29: with the evaluate-click, even fresh accounts on residential
  // BrightData IPs through the proper humanType flow got hard-banned by
  // Reddit ("This account has been banned") within minutes of the comment.
  // Fix: locate the submit button via Playwright (not evaluate), resolve
  // the form-relative selector by walking up from the textarea, then click
  // through humanClickLocator which generates a full Bezier mouse trajectory
  // landing at a randomized in-box offset, real mousedown/up via CDP.
  const submitBtn = ta.locator('xpath=ancestor::form[1]').locator('button.save, button[type="submit"]').first();
  await submitBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, submitBtn);
  // The optimistic in-page check (body text appearing in page innerText) was
  // returning true even when r/test's spam filter removed the comment server-
  // side a few seconds after submit, so the trajectory printed PASS while
  // the comment never made it to public listing. Two-step verification: (a)
  // wait for body to appear locally (submit confirmed), (b) re-fetch the
  // post listing JSON via fresh request and confirm the comment is in the
  // public tree.
  let postedLocally = false;
  let postedCommentId = null;
  for (let i = 0; i < 12; i++) {
    await humanIdlePause('short');
    const found = await s.page.evaluate((body) => {
      const text = document.body?.innerText ?? '';
      if (!text.includes(body)) return null;
      // Find the comment node we just authored — old.reddit renders
      // <div id="thing_t1_<id>" class="thing id-t1_<id> ..."> for each comment.
      // Match by walking comment nodes and checking their .usertext-body.
      const things = document.querySelectorAll('div[id^="thing_t1_"]');
      for (const el of things) {
        const md = el.querySelector('.usertext-body, .md');
        if (md && md.textContent && md.textContent.includes(body)) {
          const m = el.id.match(/^thing_t1_([a-z0-9]+)$/);
          if (m) return m[1];
        }
      }
      return 'POSTED_NO_ID';
    }, COMMENT_BODY).catch(() => null);
    if (found) {
      postedLocally = true;
      if (found !== 'POSTED_NO_ID') postedCommentId = found;
      break;
    }
  }
  banSignal = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  if (!postedLocally) throw new Error(`submit did not confirm — body did not appear in page text`);
  // Documented false-positive history: Reddit's /api/comment XHR has been
  // observed to return RATELIMIT JSON for new-account submissions that
  // ARE accepted server-side and visible in the user's authenticated
  // /comments/.json listing. Verified 2026-04-29 with mayastone2170: XHR
  // said RATELIMIT, comment id oiyy4nx is in the auth listing, account
  // about.json is 200 (not shadowbanned). Treating XHR rate_limited as a
  // definitive verdict caused 30+ false-FAIL trajectory runs.
  //
  // Verify via authenticated /user/<handle>/comments/.json before bailing.
  // If the comment is in the auth listing, the submit succeeded — fall
  // through to the public-visibility loop and let it report whether the
  // comment also surfaces unauth (true PASS) or only auth (cooling).
  if (banSignal && /^(rate_limited|shadowbanned|banned_account|banned_subreddit|thread_locked)$/.test(banSignal.signal)) {
    let xhrFalsePositive = false;
    try {
      const me = await s.page.evaluate(async () => {
        const r = await fetch('/api/me.json', { credentials: 'include' });
        const j = await r.json().catch(() => null);
        return j?.data?.name ?? null;
      });
      if (me) {
        const own = await s.page.evaluate(async (handle) => {
          const r = await fetch(`/user/${encodeURIComponent(handle)}/comments/.json?limit=10&sort=new`, { credentials: 'include' });
          const j = await r.json().catch(() => null);
          return j?.data?.children?.map((c) => c?.data?.body) ?? [];
        }, me);
        xhrFalsePositive = own.some(b => typeof b === 'string' && b.includes(COMMENT_BODY));
      }
    } catch { /* fallthrough */ }
    if (xhrFalsePositive) {
      console.log(`[ban-signal] ${banSignal.signal} XHR signal — but comment IS in auth listing. Treating as false positive, continuing to public-visibility poll.`);
      banSignal = null;
    } else {
      console.log(`[ban-signal] ${banSignal.signal} (auth listing missing the comment, real failure)`);
      throw new Error(`reddit returned ${banSignal.signal} on submit — ${banSignal?.details?.flagged_url ?? 'unknown endpoint'}`);
    }
  }
  // Verify public visibility via the comment-permalink JSON, NOT the thread
  // listing. Reddit's thread-listing endpoint (.json?limit=500&sort=new) caches
  // independently of the permalink and lags freshly-posted comments by far
  // longer than 60s — produces false-positive "rate_limited" verdicts on
  // comments that are in fact publicly visible. The permalink JSON
  // /r/<sub>/comments/<post>/comment/<id>/.json is real-time. Verified
  // 2026-04-28 with manually-posted oit1fd9: permalink had it within minutes,
  // thread listing took hours.
  let publiclyVisible = false;
  let stillVisibleAtEnd = false;
  // Need realHandle from earlier pre-check; if unset, we can't sanity-check
  // shadowban here. Re-read.
  let handle = realHandle;
  if (!handle) try { const me = await s.page.evaluate(async () => { const r = await fetch('/api/me.json', { credentials: 'include' }); const j = await r.json().catch(() => null); return j?.data?.name ?? null; }); handle = me; } catch { /* skip */ }
  // Fall back to the user's own-comment listing if we couldn't capture id from
  // the DOM (Reddit may not yet have rendered the new comment when we polled).
  const baseUrl = oldUrl.replace(/\/$/, '');
  for (let attempt = 0; attempt < 12; attempt++) {
    await humanIdlePause('long');
    try {
      let has = false;
      const ctxFetch = async (url) => {
        const resp = await s.page.context().request.get(url, { headers: { 'Accept': 'application/json' }, ignoreHTTPSErrors: true, timeout: 15000 });
        return { status: resp.status(), body: await resp.text() };
      };
      if (postedCommentId) {
        // Reddit's comment-permalink JSON format is /r/<sub>/comments/<post>/<post-slug>/<comment-id>/.json
        // (NOT /r/<sub>/comments/<post>/<post-slug>/comment/<comment-id>/.json — the
        // /comment/ segment causes 404). Verified 2026-04-29 with oj0vwon:
        // /comment/oj0vwon/.json → 404, /oj0vwon/.json → 200 + full JSON.
        const permalink = `${baseUrl}/${postedCommentId}/.json`;
        const { status, body } = await ctxFetch(permalink);
        let j = null; try { j = JSON.parse(body); } catch { /* not JSON */ }
        const commentNode = j?.[1]?.data?.children?.[0];
        has = commentNode?.kind === 't1' && commentNode?.data?.id === postedCommentId && (!handle || commentNode?.data?.author === handle);
        if (attempt === 0 || attempt === 11) console.log(`[verify-poll attempt=${attempt}] permalink id=${postedCommentId} status=${status} hasMatch=${has}`);
      } else if (handle) {
        const userUrl = `https://old.reddit.com/user/${encodeURIComponent(handle)}/comments/.json?limit=25&sort=new`;
        const { status, body } = await ctxFetch(userUrl);
        has = body.includes(COMMENT_BODY);
        if (attempt === 0 || attempt === 11) console.log(`[verify-poll attempt=${attempt}] handle=${handle} userListing status=${status} bodyLen=${body.length} hasMatch=${has}`);
      } else {
        if (attempt === 0) console.log(`[verify-poll attempt=${attempt}] no postedCommentId AND no handle — skipping`);
      }
      if (has) publiclyVisible = true;
      stillVisibleAtEnd = has;
    } catch (e) {
      if (attempt === 0 || attempt === 11) console.log(`[verify-poll attempt=${attempt}] error: ${e.message?.slice(0, 200)}`);
    }
  }
  // Final shadowban check on the account itself.
  // NOTE: about.json 404 has documented false positives for healthy accounts
  // routed through residential proxies — Reddit's edge tier can return 404
  // for the about.json endpoint specifically while the account is fine and
  // the comment IS publicly visible via permalink. If publiclyVisible is
  // already true (permalink JSON confirmed), don't let about.json 404
  // override that verdict.
  if (handle && !publiclyVisible) {
    const finalResp = await s.page.context().request.get(`https://old.reddit.com/user/${encodeURIComponent(handle)}/about.json`, { headers: { 'Accept': 'application/json' }, ignoreHTTPSErrors: true, timeout: 15000 }).catch(() => null);
    const finalStatus = finalResp ? finalResp.status() : 0;
    if (finalStatus === 404) { banSignal = { signal: 'shadowbanned', healthy: false, details: { real_handle: handle, reason: 'about.json 404 with browser UA after submit + comment NOT publicly visible — Reddit shadowbanned the account' } }; }
  }
  // Require persistence at the end of the window, not just transient visibility.
  publiclyVisible = publiclyVisible && stillVisibleAtEnd;
  // Distinguish four states when the comment isn't publicly visible:
  //   1. shadowbanned account: about.json 404 publicly, 200 authenticated
  //      (account exists but is hidden from non-logged-in viewers).
  //   2. new-account cooling: about.json 200 publicly, comment in auth
  //      listing but not in public listing (Reddit hides comments from
  //      <24h-old / <10-karma accounts until trust accrues).
  //   3. subreddit auto-filter: about.json 200 publicly, comment NOT in
  //      auth listing either (the comment was rejected by the subreddit's
  //      AutoModerator filter).
  //   4. true rate-limit: api/comment XHR returned an error AND comment
  //      is missing from auth listing.
  if (!publiclyVisible) {
    let realHandle = null;
    try {
      realHandle = await s.page.evaluate(async () => {
        const r = await fetch('/api/me.json', { credentials: 'include' });
        const j = await r.json().catch(() => null);
        return j?.data?.name ?? null;
      });
    } catch { /* skip */ }
    let unauthAboutStatus = 0;
    let inAuthListing = false;
    if (realHandle) {
      const aboutResp = await s.page.context().request.get(`https://old.reddit.com/user/${encodeURIComponent(realHandle)}/about.json`, { headers: { 'Accept': 'application/json' }, ignoreHTTPSErrors: true, timeout: 15000 }).catch(() => null);
      unauthAboutStatus = aboutResp ? aboutResp.status() : 0;
      try {
        const own = await s.page.evaluate(async (handle, body) => {
          const r = await fetch(`/user/${encodeURIComponent(handle)}/comments/.json?limit=15&sort=new`, { credentials: 'include' });
          const j = await r.json().catch(() => null);
          return (j?.data?.children ?? []).some((c) => typeof c?.data?.body === 'string' && c.data.body.includes(body));
        }, realHandle, COMMENT_BODY);
        inAuthListing = own;
      } catch { /* skip */ }
    }
    if (unauthAboutStatus === 404) {
      banSignal = { signal: 'shadowbanned', healthy: false, details: { real_handle: realHandle, reason: 'about.json 404 publicly — account shadowbanned' } };
    } else if (unauthAboutStatus === 200 && inAuthListing) {
      banSignal = { signal: 'new_account_cooling', healthy: false, details: { real_handle: realHandle, reason: 'about.json 200 + comment in auth listing but not public — Reddit cooling new account' } };
    } else if (inAuthListing) {
      banSignal = { signal: 'subreddit_filter', healthy: false, details: { real_handle: realHandle, reason: 'comment in auth listing but not public — subreddit AutoMod filtered it' } };
    } else {
      banSignal = banSignal ?? { signal: 'rate_limited', healthy: false, details: { real_handle: realHandle, reason: 'comment missing from auth listing — submission rejected' } };
    }
  }
  console.log(`[ban-signal] ${banSignal?.signal ?? 'healthy'}`);
  if (!publiclyVisible) throw new Error(`comment not publicly visible — ${banSignal.signal} (${banSignal.details?.reason ?? 'no detail'})`);
  console.log(`PASS: commented "${COMMENT_BODY}" on ${resolvedOldUrl} (verified public, in-session)`);

  // Deferred clean-session verify. The in-session 60s permalink poll above
  // catches AutoMod-removal and immediate shadowbans. It does NOT catch
  // Reddit's async spam classifier, which runs on a 60-300s delay and either
  // removes the specific comment or shadowbans the account silently. Wait
  // DEFER_VERIFY_MS, then re-fetch the comment permalink JSON via a fresh
  // proxy with NO cookies. If the comment is missing from a clean view, the
  // async classifier removed it post-hoc — flag the account.
  // Skip when DEFER_VERIFY_MS=0 (test path) or when we couldn't capture the
  // comment id (the multi-vantage about.json probe still runs as a fallback).
  if (DEFER_VERIFY_MS > 0) {
    console.log(`[deferred-verify] waiting ${DEFER_VERIFY_MS / 1000}s before clean-session probe`);
    await new Promise((r) => setTimeout(r, DEFER_VERIFY_MS));
    let stillPublic = null;
    if (postedCommentId) {
      const probe = await probeCommentVisibility({
        postPermalinkBase: resolvedOldUrl,
        commentId: postedCommentId,
        expectedAuthor: handle ?? undefined,
      });
      stillPublic = probe.visible;
      console.log(`[deferred-verify] permalink probe: visible=${probe.visible} status=${probe.status} exit_ip=${probe.exit_ip ?? '?'}`);
    }
    // If we couldn't pin the comment id, fall back to multi-vantage account
    // probe — if the WHOLE account is shadowbanned, the user-level check
    // catches it.
    if (stillPublic === null && handle) {
      const probe = await probeShadowban(handle, 3).catch(() => null);
      if (probe) {
        console.log(`[deferred-verify] account probe: verdict=${probe.verdict}`);
        stillPublic = probe.verdict !== 'shadowbanned';
      }
    }
    if (stillPublic === false) {
      banSignal = {
        signal: 'shadowbanned',
        healthy: false,
        details: {
          real_handle: handle,
          reason: 'comment was publicly visible immediately after submit, but missing from a clean-session probe ' + Math.round(DEFER_VERIFY_MS / 1000) + 's later — async classifier shadowban',
        },
      };
      // Auto-flag in social_accounts to pull from rotation.
      const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
      if (supabaseUrl && key && acct.id) {
        await fetch(`${supabaseUrl}/rest/v1/social_accounts?id=eq.${acct.id}`, {
          method: 'PATCH',
          headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'shadowbanned' }),
        }).catch(() => {});
        console.log(`[deferred-verify] auto-flagged ${acct.username} status=shadowbanned`);
      }
      throw new Error('deferred clean-session probe: comment removed within ' + Math.round(DEFER_VERIFY_MS / 1000) + 's of submit');
    }
    console.log(`PASS: comment confirmed visible from clean session at t+${DEFER_VERIFY_MS / 1000}s`);
  }
} catch (e) {
  banSignal = banSignal ?? await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  if (banSignal) console.log(`[ban-signal] ${banSignal.signal}`);
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exitCode = 1;
} finally {
  if (banSignal) {
    try {
      const dir = join(process.cwd(), 'recordings', 'reddit_comment');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, ...banSignal, ts: new Date().toISOString() }, null, 2));
    } catch (e) { console.log('[ban-signal] persist err:', e.message); }
  }
  await s.close();
}
