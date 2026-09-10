import { humanIdlePause } from '../../../../../../dist/human/mouse.js';
import { VISIBILITY_POLLS } from './constants.mjs';
import { contextRead, ownListingHas, publicAboutStatus, readOwnHandle } from './reddit_json.mjs';

/**
 * Documented false-positive history: Reddit's /api/comment XHR has been
 * observed to return RATELIMIT JSON for new-account submissions that ARE
 * accepted server-side and visible in the user's authenticated
 * /comments/.json listing. Verified 2026-04-29 with mayastone2170: XHR said
 * RATELIMIT, comment id oiyy4nx is in the auth listing, account about.json is
 * 200 (not shadowbanned). Treating XHR rate_limited as a definitive verdict
 * caused 30+ false-FAIL trajectory runs.
 *
 * So a blocking XHR signal is checked against the authenticated listing
 * first. Returns false when the listing has the comment (the signal was a
 * false positive); throws when it does not (a real failure).
 */
export async function confirmBlockingSignal(s, banSignal, body) {
  if (!banSignal || !/^(rate_limited|shadowbanned|banned_account|banned_subreddit|thread_locked)$/.test(banSignal.signal)) return banSignal;
  let inAuthListing = false;
  try {
    const me = await readOwnHandle(s.page);
    if (me) inAuthListing = await ownListingHas(s.page, me, body, 10);
  } catch (e) {
    console.log(`[ban-signal] auth listing unreadable: ${e.message?.slice(0, 120)}`);
  }
  if (inAuthListing) {
    console.log(`[ban-signal] ${banSignal.signal} XHR signal — but comment IS in auth listing. Treating as false positive, continuing to public-visibility poll.`);
    return false;
  }
  console.log(`[ban-signal] ${banSignal.signal} (auth listing missing the comment, real failure)`);
  throw new Error(`reddit returned ${banSignal.signal} on submit — ${banSignal?.details?.flagged_url ?? 'unknown endpoint'}`);
}

/**
 * Verify public visibility via the comment-permalink JSON, NOT the thread
 * listing. Reddit's thread-listing endpoint (.json?limit=500&sort=new) caches
 * independently of the permalink and lags freshly-posted comments by far
 * longer than 60s — produces false-positive "rate_limited" verdicts on
 * comments that are in fact publicly visible. The permalink JSON
 * /r/<sub>/comments/<post>/<slug>/<id>/.json is real-time. Verified
 * 2026-04-28 with manually-posted oit1fd9: permalink had it within minutes,
 * thread listing took hours. Without a captured comment id the user's own
 * comment listing is read instead.
 *
 * Returns { publiclyVisible, stillVisibleAtEnd }: seen at least once, and
 * seen on the last poll.
 */
export async function pollPublicVisibility(s, { baseUrl, postedCommentId, handle, body }) {
  let publiclyVisible = false;
  let stillVisibleAtEnd = false;
  const last = VISIBILITY_POLLS - 1;
  for (let poll = 0; poll < VISIBILITY_POLLS; poll++) {
    await humanIdlePause('long');
    const report = poll === 0 || poll === last;
    try {
      let has = false;
      if (postedCommentId) {
        // Reddit's comment-permalink JSON format is /r/<sub>/comments/<post>/<post-slug>/<comment-id>/.json
        // (NOT /r/<sub>/comments/<post>/<post-slug>/comment/<comment-id>/.json — the
        // /comment/ segment causes 404). Verified 2026-04-29 with oj0vwon:
        // /comment/oj0vwon/.json → 404, /oj0vwon/.json → 200 + full JSON.
        const { status, body: text } = await contextRead(s, `${baseUrl}/${postedCommentId}/.json`);
        let j = false; try { j = JSON.parse(text); } catch { /* not JSON: the permalink answered with a page */ }
        const commentNode = j?.[1]?.data?.children?.[0];
        has = commentNode?.kind === 't1' && commentNode?.data?.id === postedCommentId && (!handle || commentNode?.data?.author === handle);
        if (report) console.log(`[verify-poll attempt=${poll}] permalink id=${postedCommentId} status=${status} hasMatch=${has}`);
      } else if (handle) {
        const { status, body: text } = await contextRead(s, `https://old.reddit.com/user/${encodeURIComponent(handle)}/comments/.json?limit=25&sort=new`);
        has = text.includes(body);
        if (report) console.log(`[verify-poll attempt=${poll}] handle=${handle} userListing status=${status} bodyLen=${text.length} hasMatch=${has}`);
      } else if (poll === 0) {
        console.log(`[verify-poll attempt=${poll}] no postedCommentId AND no handle — skipping`);
      }
      if (has) publiclyVisible = true;
      stillVisibleAtEnd = has;
    } catch (e) {
      if (report) console.log(`[verify-poll attempt=${poll}] error: ${e.message?.slice(0, 200)}`);
    }
  }
  // Require persistence at the end of the window, not just transient visibility.
  return { publiclyVisible: publiclyVisible && stillVisibleAtEnd, stillVisibleAtEnd };
}

/**
 * Distinguish four states when the comment isn't publicly visible:
 *   1. shadowbanned account: about.json 404 publicly, 200 authenticated
 *      (account exists but is hidden from non-logged-in viewers).
 *   2. new-account cooling: about.json 200 publicly, comment in auth
 *      listing but not in public listing (Reddit hides comments from
 *      <24h-old / <10-karma accounts until trust accrues).
 *   3. subreddit auto-filter: about.json 200 publicly, comment NOT in
 *      auth listing either (the comment was rejected by the subreddit's
 *      AutoModerator filter).
 *   4. true rate-limit: api/comment XHR returned an error AND comment
 *      is missing from auth listing.
 * `priorSignal` is the XHR signal, kept for state 4 when nothing else fits.
 */
export async function classifyInvisibleComment(s, priorSignal, body) {
  let realHandle = false;
  try { realHandle = await readOwnHandle(s.page); } catch (e) { console.log(`[ban-signal] own handle unreadable: ${e.message?.slice(0, 120)}`); }
  let unauthAboutStatus = 0;
  let inAuthListing = false;
  if (realHandle) {
    try { unauthAboutStatus = await publicAboutStatus(s, realHandle); } catch (e) { console.log(`[ban-signal] about.json unreadable: ${e.message?.slice(0, 120)}`); }
    try { inAuthListing = await ownListingHas(s.page, realHandle, body, 15); } catch (e) { console.log(`[ban-signal] auth listing unreadable: ${e.message?.slice(0, 120)}`); }
  }
  if (unauthAboutStatus === 404) {
    return { signal: 'shadowbanned', healthy: false, details: { real_handle: realHandle, reason: 'about.json 404 publicly — account shadowbanned' } };
  }
  if (unauthAboutStatus === 200 && inAuthListing) {
    return { signal: 'new_account_cooling', healthy: false, details: { real_handle: realHandle, reason: 'about.json 200 + comment in auth listing but not public — Reddit cooling new account' } };
  }
  if (inAuthListing) {
    return { signal: 'subreddit_filter', healthy: false, details: { real_handle: realHandle, reason: 'comment in auth listing but not public — subreddit AutoMod filtered it' } };
  }
  return priorSignal || { signal: 'rate_limited', healthy: false, details: { real_handle: realHandle, reason: 'comment missing from auth listing — submission rejected' } };
}
