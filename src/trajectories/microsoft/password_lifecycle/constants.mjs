// The waits, bounds and URLs of microsoft/password_lifecycle.mjs and its steps.

export const MICROSOFT_PASSWORD_ID = /^weles-microsoft-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?-password$/;
export const PASSWORD_FIELD = 'password';
export const PASSWORD_CHANGE_URL = 'https://account.live.com/password/Change';
export const LOGIN_URL = 'https://login.live.com/login.srf';
export const IDENTITY_CHALLENGE = /verify your identity|get a code|approve sign in|enter.{0,20}code|passkey|security key/i;
export const LOGIN_HOSTS = ['login.live.com', 'login.microsoft.com'];

// A generated Microsoft password: one character from each group, then random
// characters from all groups up to this length.
export const GENERATED_PASSWORD_LENGTH = 32;

// The verification-code file the operator drops beside a running lifecycle:
// owner-only mode, at most this many bytes, polled for this long.
export const CODE_FILE_MODE = 0o600;
export const CODE_FILE_MODE_MASK = 0o777;
export const CODE_FILE_MAX_BYTES = 32;
export const CODE_FILE_WAIT_MS = 300_000;

// Pauses after Microsoft's own page transitions.
export const DISMISS_SETTLE_MS = 500;
export const PAGE_SETTLE_MS = 1000;
export const STEP_SETTLE_MS = 1500;

// How long a field or link is given to appear.
export const FIELD_WAIT_MS = 30_000;
export const RECOVERY_FIELD_WAIT_MS = 45_000;
export const NEW_PASSWORD_FORM_WAIT_MS = 120_000;

// How long the password form is given to appear after the email challenge.
export const PASSWORD_PAGE_WAIT_MS = 150_000;

// Pages Microsoft opens during a change; the second password input marks the form.
export const SECOND_PASSWORD_INPUT = 1;
