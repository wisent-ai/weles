import { ORIGIN_VISIT_WAIT_MS } from './constants.mjs';

/**
 * Restore full storage state (cookies + per-origin localStorage). The
 * localStorage half is critical: Reddit's web app writes anti-bot tokens
 * (loid, _id_secret, redditcmoreId, telemetry session id, eu_cookie_v2)
 * into localStorage on first load, then sends them as XHR headers
 * (x-reddit-loid etc.) on every subsequent action. Restoring ONLY cookies
 * means the comment XHR has session=valid but loid/telemetry=missing,
 * which Reddit's anti-bot tags as "session moved to different device" and
 * shadowbans the account within seconds. Old accounts (registered before
 * 2026-04-29) only have cookies stored — those get the cookie-only restore.
 */
export async function restoreRedditSession(s, acct) {
  const ss = acct.metadata?.storage_state;
  if (ss && Array.isArray(ss.cookies) && ss.cookies.length) {
    const valid = ss.cookies.filter(c => c.name && c.value && c.domain).map(c => ({ ...c, path: c.path || '/' }));
    if (valid.length) await s.ctx.addCookies(valid);
    // localStorage restoration: requires a document context per origin, so
    // visit each origin once with a no-network blank doc, then setItem.
    for (const o of ss.origins ?? []) {
      if (!o?.origin || !Array.isArray(o.localStorage) || !o.localStorage.length) continue;
      try {
        await s.page.goto(o.origin, { waitUntil: 'domcontentloaded', timeout: ORIGIN_VISIT_WAIT_MS });
        await s.page.evaluate((items) => {
          for (const it of items) { try { window.localStorage.setItem(it.name, it.value); } catch { /* the origin refused this key */ } }
        }, o.localStorage);
      } catch (e) { console.log(`[trajectory] storage-state restore origin=${o.origin} skipped: ${e.message?.slice(0, 80)}`); }
    }
    console.log(`[trajectory] restored storage_state: ${valid.length} cookies + ${ss.origins?.reduce((n, o) => n + (o.localStorage?.length ?? 0), 0) ?? 0} localStorage entries across ${ss.origins?.length ?? 0} origin(s)`);
    return;
  }
  const stored = (acct.metadata?.cookies ?? []).filter(c => /reddit\.com/.test(c.domain ?? ''));
  if (stored.length) await s.ctx.addCookies(stored.map(c => ({ ...c, path: c.path || '/' })));
  console.log(`[trajectory] legacy account (no storage_state) — restored ${stored.length} cookies only. Account vulnerable to "session-on-new-device" detection.`);
}
