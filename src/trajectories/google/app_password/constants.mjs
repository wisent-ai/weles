// The addresses, names and bounds google/app_password/create.mjs uses.

export const APP_PASSWORDS_URL = 'https://myaccount.google.com/apppasswords?hl=en';

// The name Google lists the password under on the account's App passwords
// page, so the owner can see which product holds it and revoke it there.
export const APP_NAME = 'Skrzynka';

// The product that verifies the password over IMAP, stores it in Skarbiec and
// declares the mailbox; WELES_SKRZYNKA_BIN names another executable.
export const SKRZYNKA_BIN_VARIABLE = 'WELES_SKRZYNKA_BIN';
export const SKRZYNKA_DEFAULT_BIN = 'skrzynka';

// Seconds Google takes to settle each settings page after navigation or a click.
export const PAGE_SETTLE_SECONDS = 4;

// How many times the page is opened again after Google asks to re-enter the
// password before creating the app password.
export const SIGN_IN_ROUNDS = 2;

// Enough of a page to name what it showed, after any password is redacted.
export const PREVIEW_CHARS = 1600;

// How much of Skrzynka's refusal is kept in the run's result.
export const SKRZYNKA_DETAIL_CHARS = 2000;
