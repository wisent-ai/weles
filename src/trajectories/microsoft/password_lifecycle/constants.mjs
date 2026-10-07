// The bounds and URLs of microsoft/password_lifecycle.mjs and its steps.

export const MICROSOFT_PASSWORD_ID = /^weles-microsoft-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?-password$/;
export const PASSWORD_FIELD = 'password';
export const PASSWORD_CHANGE_URL = 'https://account.live.com/password/Change';
export const LOGIN_URL = 'https://login.live.com/login.srf';
export const IDENTITY_CHALLENGE = /verify your identity|get a code|approve sign in|enter.{0,20}code|passkey|security key/i;
export const LOGIN_HOSTS = ['login.live.com', 'login.microsoft.com'];

// The verification-code file the operator drops beside a running lifecycle:
// owner-only mode, at most this many bytes.
export const CODE_FILE_MODE = 0o600;
export const CODE_FILE_MODE_MASK = 0o777;
export const CODE_FILE_MAX_BYTES = 32;

// Pages Microsoft opens during a change; the second password input marks the form.
export const SECOND_PASSWORD_INPUT = 1;
