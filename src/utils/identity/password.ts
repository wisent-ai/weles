import { randomInt, randomUUID } from 'node:crypto';
import { minimumGeneratedLength } from '../../state/skarbiec-records.js';
import { localCredentialsFile } from '../../secrets/scoped-service/local-file.js';

// Sign-up forms check for one character of each class; base64url alone has
// no character TikTok counts as special. Look-alike characters are left out
// so a password read back from a screen is the one typed.
const LETTERS_AND_DIGITS = Object.freeze([
  'ABCDEFGHJKLMNPQRSTUVWXYZ',
  'abcdefghijkmnpqrstuvwxyz',
  '23456789',
]);
const SYMBOLS = '!@#$%&*';

/** What one provider's password form accepts, when it narrows the default. */
export type PasswordRules = {
  /** The only special characters the provider accepts (Oxylabs: `_~+=`). */
  symbols?: string;
};

/**
 * A password for an account Weles registers or resets: one character of
 * every class, the rest from all of them, shuffled, at the length the vault's
 * policy states (`skarbiec policy-set min_generated_length <N>`). Each
 * trajectory used to choose its own length and alphabet (eight to thirty-two
 * characters, four hand-written generators); now the operator states the
 * length once, where Skarbiec checks every generated secret against it, and
 * a provider narrows only the symbols its form accepts.
 */
export function registrationPassword(rules: PasswordRules = {}): string {
  const symbols = rules.symbols ?? SYMBOLS;
  if (!symbols) {
    throw new Error('a provider rule named an empty symbol alphabet; name the symbols its form accepts');
  }
  const classes = [...LETTERS_AND_DIGITS, symbols];
  const length = statedLength();
  if (length < classes.length) {
    throw new Error(
      `the stated password length ${length} (${localCredentialsFile() ? 'WELES_GENERATED_PASSWORD_LENGTH' : "the vault policy's min_generated_length"}) is shorter than the ${classes.length} character classes a password carries one of each`,
    );
  }
  const pick = (characters: string) => characters[randomInt(characters.length)];
  const everything = classes.join('');
  const characters = [
    ...classes.map(pick),
    ...Array.from({ length: length - classes.length }, () => pick(everything)),
  ];
  return characters
    .map((character) => ({ character, order: randomUUID() }))
    .sort((a, b) => a.order.localeCompare(b.order))
    .map(({ character }) => character)
    .join('');
}

/**
 * The length every generated password takes: the vault policy's
 * min_generated_length, or, on a machine running without Skarbiec
 * (WELES_CREDENTIALS_FILE set), WELES_GENERATED_PASSWORD_LENGTH. A fleet host
 * that lost Skarbiec still asks Skarbiec and fails with its refusal.
 */
function statedLength(): number {
  if (localCredentialsFile()) {
    const raw = process.env.WELES_GENERATED_PASSWORD_LENGTH?.trim() ?? '';
    const stated = Number(raw);
    if (!raw || !Number.isSafeInteger(stated) || !(stated > Number.MIN_VALUE)) {
      throw new Error(
        `WELES_GENERATED_PASSWORD_LENGTH is ${raw ? `"${raw}", not a whole number above zero` : 'not set'}: `
        + 'without Skarbiec declare how long a generated account password is',
      );
    }
    return stated;
  }
  const length = minimumGeneratedLength();
  if (length === null) {
    throw new Error(
      'Weles generates account passwords at the length the vault policy states, and it states none: '
      + 'set it with `skarbiec policy-set min_generated_length <length>`',
    );
  }
  return length;
}
