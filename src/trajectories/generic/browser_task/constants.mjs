// The waits generic/browser_task.mjs puts on the vendor sign-in surfaces it
// establishes a session on before the agent starts.

// A "Continue with Google" click may take this long to open its OAuth page.
export const OAUTH_PAGE_WAIT_MS = 10_000;

// Figma's password field appears this long after the email step at most.
export const PASSWORD_FIELD_WAIT_MS = 10_000;

// Figma leaves /login this long after a direct credential login at most.
export const LOGIN_LEAVE_WAIT_MS = 15_000;

// The vendor dashboard (Supabase, Figma files or settings) after a completed SSO.
export const DASHBOARD_WAIT_MS = 30_000;

// A required browser-evidence artifact larger than this is refused.
export const EVIDENCE_ARTIFACT_LIMIT_BYTES = 8 * 1024 * 1024;
