// The waits linkedin/login.mjs and its steps put on LinkedIn's own surfaces.

// How long the "Continue with Google" click may take to open its OAuth popup or
// tab before the login reports google_sso_popup_not_opened.
export const OAUTH_SURFACE_WAIT_MS = 15000;

// async_api sets context.setDefaultNavigationTimeout(0) (unbounded) for long
// Arkose iframe loads on tiktok signup. The login needs an explicit cap so a
// stalled sticky session doesn't burn the worker's 600s budget (verified
// 2026-05-03: 3-of-6 test rows hit SIGKILL with no log line past
// launchPersistentContext — goto was hung).
export const GOTO_MS = 30 * 1000;

// The retroactive email confirmation after a successful login is best-effort;
// it must not hold a PASS hostage to a slow inbox.
export const CONFIRM_EMAIL_WAIT_MS = 10_000;
