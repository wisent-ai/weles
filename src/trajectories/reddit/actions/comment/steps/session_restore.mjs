/**
 * Restore cookies and per-origin localStorage so session headers can refer to
 * the same stored session. Records without full storage state use their
 * cookie-only representation.
 */
export async function restoreRedditSession(s, acct) {
  const ss = acct.metadata?.storage_state;
  if (ss && Array.isArray(ss.cookies) && ss.cookies.length) {
    const valid = ss.cookies
      .filter((c) => c.name && c.value && c.domain)
      .map((c) => ({ ...c, path: c.path || '/' }));
    if (valid.length) await s.ctx.addCookies(valid);
    // localStorage restoration: requires a document context per origin, so
    // visit each origin once with a no-network blank doc, then setItem.
    for (const o of ss.origins ?? []) {
      if (
        !o?.origin ||
        !Array.isArray(o.localStorage) ||
        !o.localStorage.length
      )
        continue;
      try {
        await s.page.goto(o.origin, { waitUntil: 'domcontentloaded' });
        await s.page.evaluate((items) => {
          for (const it of items) {
            try {
              window.localStorage.setItem(it.name, it.value);
            } catch {
              /* the origin refused this key */
            }
          }
        }, o.localStorage);
      } catch (e) {
        console.log(
          `[trajectory] storage-state restore origin=${o.origin} skipped: ${e.message}`,
        );
      }
    }
    console.log(
      `[trajectory] restored storage_state: ${valid.length} cookies + ${ss.origins?.reduce((n, o) => n + (o.localStorage?.length ?? 0), 0) ?? 0} localStorage entries across ${ss.origins?.length ?? 0} origin(s)`,
    );
    return;
  }
  const stored = (acct.metadata?.cookies ?? []).filter((c) =>
    /reddit\.com/.test(c.domain ?? ''),
  );
  if (stored.length)
    await s.ctx.addCookies(stored.map((c) => ({ ...c, path: c.path || '/' })));
  console.log(
    `[trajectory] legacy account (no storage_state) — restored ${stored.length} cookies only. Account vulnerable to "session-on-new-device" detection.`,
  );
}
