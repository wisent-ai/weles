import { BUSY_POST_COMMENTS, JSON_READ_WAIT_MS, LISTING_PICK_WINDOW } from './constants.mjs';

/** The signed-in account's handle from /api/me.json, or false when Reddit answers without one. */
export function readOwnHandle(page) {
  return page.evaluate(async () => {
    const r = await fetch('/api/me.json', { credentials: 'include' });
    const j = await r.json();
    return j?.data?.name ?? false;
  });
}

/** Whether the account's own newest comments, read while signed in, contain `body`. */
export function ownListingHas(page, handle, body, limit) {
  return page.evaluate(async (args) => {
    const r = await fetch(`/user/${encodeURIComponent(args.handle)}/comments/.json?limit=${args.limit}&sort=new`, { credentials: 'include' });
    const j = await r.json();
    return (j?.data?.children ?? []).some((c) => typeof c?.data?.body === 'string' && c.data.body.includes(args.body));
  }, { handle, body, limit });
}

/** One JSON read through the session's request context: status plus body text. */
export async function contextRead(s, url) {
  const resp = await s.page.context().request.get(url, { headers: { 'Accept': 'application/json' }, ignoreHTTPSErrors: true, timeout: JSON_READ_WAIT_MS });
  return { status: resp.status(), body: await resp.text() };
}

/** The HTTP status of the account's public about.json, read without cookies. */
export async function publicAboutStatus(s, handle) {
  const { status } = await contextRead(s, `https://old.reddit.com/user/${encodeURIComponent(handle)}/about.json`);
  return status;
}

/**
 * If the target points to a sub listing (no /comments/<id>/ segment), pick a
 * recent post from the sub via the JSON API. Lets the default URL be a
 * newbie-tolerant sub root rather than a specific post that may go stale.
 * Returns the old.reddit.com post URL, or the listing URL itself when the
 * listing could not be read.
 */
export async function resolveTargetPost(page, oldUrl) {
  if (/\/comments\/[a-z0-9]+\//i.test(oldUrl)) return oldUrl;
  try {
    const listingSrc = oldUrl.endsWith('/') ? oldUrl : oldUrl + '/';
    const listingJson = listingSrc.replace(/\/$/, '/.json?limit=25');
    const data = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      if (!r.ok) throw new Error(`listing answered HTTP ${r.status}`);
      return await r.json();
    }, listingJson);
    const candidates = (data?.data?.children ?? [])
      .map(c => c.data)
      .filter(p => p && !p.locked && !p.archived && (p.num_comments ?? 0) < BUSY_POST_COMMENTS);
    const pick = candidates[Math.floor(Math.random() * Math.min(candidates.length, LISTING_PICK_WINDOW))];
    const resolved = pick?.permalink ? `https://old.reddit.com${pick.permalink}` : oldUrl;
    console.log(`[trajectory] resolved sub listing -> post ${resolved}`);
    return resolved;
  } catch (e) {
    console.log(`[trajectory] sub listing fetch err: ${e.message?.slice(0, 100)}`);
    return oldUrl;
  }
}
