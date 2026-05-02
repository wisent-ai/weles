/**
 * Positive auth probe — the ONLY way an action trajectory or login flow may
 * claim "logged in". URL-bounce checks ("did /messages redirect to /login?")
 * are FORBIDDEN as the sole auth signal because every major platform serves
 * a logged-out-but-public shell on shell URLs (TikTok /foryou, Twitter /home,
 * Reddit /, etc.) for SEO / preview purposes. URL didn't bounce ≠ session is
 * authenticated server-side. We learned this the hard way on TikTok where
 * cookie-first declared PASS but the comment input never rendered because
 * TikTok's server rejected the device-mismatched session — the page loaded,
 * just without authed UI.
 *
 * Every platform here defines:
 *   - authedSelectors: at least one of these must be visible on a loaded
 *     page for the session to count as authed (avatar, compose button,
 *     account menu — UI that ONLY renders for the actual logged-in user).
 *   - loggedOutMarkers: optional. If any of these is visible AND no authed
 *     selector is, we know with high confidence the session is dead (login
 *     CTA, sign-in button, etc.) and surface a clearer reason.
 *
 * Usage:
 *   import { assertAuthed } from './_shared/auth-probe.mjs';
 *   await assertAuthed('tiktok', s);  // throws on auth failure
 *
 * On failure the thrown error carries `.banSignal = { signal: 'checkpoint',
 * healthy: false, ... }` so the caller (action-runner, login flow) can
 * persist a structured ban_signal and the worker can mark cookies stale +
 * enqueue a fresh login.
 *
 * NEVER bypass this with URL-bounce checks. If a new platform is added,
 * pick a real authed-only DOM marker by inspecting the live page logged-in,
 * then logged-out, and confirming the marker is present in the first and
 * absent in the second. Drive-by additions without this verification are
 * how the cookie-first false-positive kept slipping past review.
 */

const PROBES = {
  tiktok: {
    // Verified 2026-05-01: when device-mismatched cookies are injected,
    // TikTok serves /foryou and /messages without redirect, but the
    // comment panel shows "Log in to comment" and the create-post button
    // is absent. Use the topbar profile / DM markers as the authed signal.
    authedSelectors: [
      '[data-e2e="profile-icon"]',
      '[data-e2e="nav-profile"]',
      'a[href*="/messages"][data-e2e]',
      'div[data-e2e="upload-icon"]',
    ],
    loggedOutMarkers: [
      'button[data-e2e="top-login-button"]',
      'button[data-e2e="login-button"]',
    ],
    bodyTextNegative: /log in to comment|log in to like|log in to follow/i,
  },
  twitter: {
    authedSelectors: [
      '[data-testid="SideNav_AccountSwitcher_Button"]',
      '[data-testid="SideNav_NewTweet_Button"]',
      '[data-testid="AppTabBar_Profile_Link"]',
      'a[href="/compose/post"]',
      'a[data-testid="AppTabBar_DirectMessage_Link"]',
    ],
    loggedOutMarkers: [
      '[data-testid="loginButton"]',
      '[data-testid="login"]',
      'a[href="/login"]',
    ],
  },
  instagram: {
    authedSelectors: [
      'a[href="/direct/inbox/"]',
      'svg[aria-label="New post"]',
      'a[href^="/accounts/edit"]',
      'a[role="link"][href^="/"][aria-label*="Profile" i]',
    ],
    loggedOutMarkers: [
      'input[name="username"]',
      'input[name="email"]',
      'a[href="/accounts/login/"]',
    ],
  },
  reddit: {
    // Works for old.reddit + modern shreddit. The legacy shreddit visible
    // markers (USER_DROPDOWN_ID, a[/submit], logged_in_user_dropdown) are
    // dead in 2026-05 shreddit which now defers most authed UI to runtime
    // hydration. The SSR HTML still emits structural-but-non-visual markers
    // that ONLY render when the request was authed:
    //   <shreddit-async-loader src="/svc/shreddit/user-drawer-button-logged-in">
    //   <achievements-entrypoint username="USERNAME">
    //   <after-login-toast-dispatcher username="USERNAME">
    // These have style:contents or no box at all, so isVisible() returns
    // false. Use presenceSelectors (count > 0) for them.
    authedSelectors: [
      // legacy shreddit (kept for older renders)
      '#USER_DROPDOWN_ID',
      'button[id^="USER_DROPDOWN"]',
      'a[href="/submit"]',
      'faceplate-tracker[noun="logged_in_user_dropdown"]',
      // old.reddit
      'span.user a[href*="/user/"]',
    ],
    presenceSelectors: [
      'shreddit-async-loader[src*="user-drawer-button-logged-in"]',
      'achievements-entrypoint[username]',
      'after-login-toast-dispatcher[username]',
    ],
    loggedOutMarkers: [
      'a[href*="/login"]',
      'a[href*="oauth.reddit.com/auth"]',
    ],
  },
  github: {
    authedSelectors: [
      'summary img.avatar-user',
      'meta[name="user-login"][content]',
      'a[href="/notifications"]',
    ],
    loggedOutMarkers: [
      'a[href="/login"]',
      'form[action="/session"]',
    ],
  },
  youtube: {
    authedSelectors: [
      'img#avatar-btn',
      'button[aria-label*="Account menu" i]',
      'ytd-topbar-menu-button-renderer button[aria-label*="Account" i]',
    ],
    loggedOutMarkers: [
      'a[aria-label="Sign in"]',
      'a[href*="accounts.google.com"][aria-label*="Sign in" i]',
    ],
  },
  linkedin: {
    authedSelectors: [
      '.global-nav__me-photo',
      'img.global-nav__me-photo',
      'a[data-control-name="identity_profile_photo"]',
      'button[data-control-name="nav.settings_signout"]',
    ],
    loggedOutMarkers: [
      'a[data-tracking-control-name*="auth-typeahead"]',
      'form[action*="/checkpoint/lg/login-submit"]',
      'a[href="/login"]',
    ],
  },
  discord: {
    authedSelectors: [
      '[data-list-item-id^="guildsnav"]',
      '[class*="userBadgeContainer"]',
      'div[aria-label="Servers sidebar"]',
    ],
    loggedOutMarkers: [
      'input[name="email"]',
      'button[type="submit"]',
    ],
  },
  producthunt: {
    authedSelectors: [
      'a[href*="/@"][data-test*="user"]',
      'button[data-test="user-menu"]',
    ],
    loggedOutMarkers: [
      'a[href*="/sign-in"]',
      'a[href*="/sign-up"]',
    ],
  },
  snapchat: {
    authedSelectors: [
      'button[aria-label="Compose Chat"]',
      'div[data-testid="conversation-list"]',
    ],
    loggedOutMarkers: [
      'a[href*="/web/accounts/login"]',
    ],
  },
};

class AuthProbeError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'AuthProbeError';
    this.banSignal = {
      signal: 'checkpoint',
      healthy: false,
      details: { reason: message.slice(0, 200), ...details },
    };
  }
}

/**
 * Assert that the current page (loaded in s.page) shows authed UI for the
 * given platform. Throws AuthProbeError on failure with banSignal attached.
 *
 * Caller must have already navigated to a page where authed UI would
 * render (a feed, profile, or any post-cookie-injection page). This
 * function does NOT navigate — it only inspects the current DOM.
 *
 * Returns the matched authed selector on success (useful for logging).
 */
export async function assertAuthed(platform, s, opts = {}) {
  const probe = PROBES[platform];
  if (!probe) {
    throw new AuthProbeError(`assertAuthed: no probe defined for platform=${platform} — add one to auth-probe.mjs`, { platform });
  }
  const timeout = opts.timeout ?? 6000;
  const settleMs = opts.settleMs ?? 1500;
  const label = opts.label ?? 'auth-probe';

  // Give the SPA a moment to mount user-specific UI after the initial
  // navigation. Twitter / Instagram / TikTok all hydrate the topbar via
  // a post-load XHR; rushing the probe will false-fail on a healthy
  // session that just hasn't finished mounting.
  await s.page.waitForTimeout(settleMs).catch(() => {});

  // Pass 1: any authed selector visible?
  const deadline = Date.now() + timeout;
  let lastErrors = [];
  while (Date.now() < deadline) {
    for (const sel of probe.authedSelectors) {
      try {
        const visible = await s.page.locator(sel).first().isVisible({ timeout: 500 });
        if (visible) {
          console.log(`[${label}] authed: ${platform} matched ${sel}`);
          return sel;
        }
      } catch (e) { lastErrors.push(`${sel}: ${e.message?.slice(0, 60)}`); }
    }
    // presenceSelectors: structural markers emitted by SSR only when authed
    // but with no visible bounding box (e.g. shreddit's user-drawer-button-
    // logged-in async-loader, username-bearing custom elements). Use count.
    for (const sel of probe.presenceSelectors ?? []) {
      try {
        const n = await s.page.locator(sel).count();
        if (n > 0) {
          console.log(`[${label}] authed: ${platform} matched ${sel} (presence-only, count=${n})`);
          return sel;
        }
      } catch (e) { lastErrors.push(`${sel}: ${e.message?.slice(0, 60)}`); }
    }
    await s.page.waitForTimeout(500);
  }

  // Pass 2: collect logged-out markers + page-text negative for diagnostics.
  const foundLoggedOut = [];
  for (const sel of probe.loggedOutMarkers ?? []) {
    try {
      if (await s.page.locator(sel).first().isVisible({ timeout: 500 })) foundLoggedOut.push(sel);
    } catch {}
  }
  let bodyTextHit = null;
  if (probe.bodyTextNegative) {
    try {
      const text = await s.page.evaluate(() => (document.body?.innerText || '').slice(0, 4000));
      const m = text.match(probe.bodyTextNegative);
      if (m) bodyTextHit = m[0];
    } catch {}
  }
  const finalUrl = s.page.url?.() ?? '';
  throw new AuthProbeError(
    `${platform} session not authenticated — no authed UI found${foundLoggedOut.length ? ` (logged-out markers: ${foundLoggedOut.join(', ')})` : ''}${bodyTextHit ? ` (body: "${bodyTextHit}")` : ''}`,
    { platform, final_url: finalUrl, logged_out_markers: foundLoggedOut, body_text_hit: bodyTextHit },
  );
}

export { AuthProbeError };
