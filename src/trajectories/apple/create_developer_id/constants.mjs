// The waits apple/create_developer_id.mjs puts on Apple's sign-in widget and
// the developer portal.

export const ADD_URL = 'https://developer.apple.com/account/resources/certificates/add';

// One navigation to the portal; WELES_APPLE_NAV_TIMEOUT_MS overrides it.
export const NAVIGATION_WAIT_MS = Number(process.env.WELES_APPLE_NAV_TIMEOUT_MS ?? '60000');

// The idmsa sign-in iframe and its email field.
export const AUTH_FRAME_WAIT_MS = 30_000;
export const EMAIL_FIELD_WAIT_MS = 15_000;

// The sign-in button enabling itself after the credentials are typed.
export const SIGN_IN_ENABLE_WAIT_MS = 10_000;

// The six-digit code arriving through the challenge relay, polled at the interval.
export const TWO_FACTOR_WAIT_MS = 120_000;
export const TWO_FACTOR_POLL_MS = 500;

// The CSR upload control and the certificate download.
export const FILE_INPUT_WAIT_MS = 20_000;
export const DOWNLOAD_WAIT_MS = 120_000;

// Seconds-long polls, one per second, for the state after the password and for the portal.
export const POST_PASSWORD_POLLS = 30;
export const PORTAL_POLLS = 30;
