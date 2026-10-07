// The addresses and names google/app_password/create.mjs uses.

export const APP_PASSWORDS_URL =
  'https://myaccount.google.com/apppasswords?hl=en';

// The name Google lists the password under on the account's App passwords
// page, so the owner can see which product holds it and revoke it there.
export const APP_NAME = 'Skrzynka';

// The product that verifies the password over IMAP, stores it in Skarbiec and
// declares the mailbox; WELES_SKRZYNKA_BIN names another executable.
export const SKRZYNKA_BIN_VARIABLE = 'WELES_SKRZYNKA_BIN';
export const SKRZYNKA_DEFAULT_BIN = 'skrzynka';
