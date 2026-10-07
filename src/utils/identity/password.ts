import { randomInt, randomUUID } from 'node:crypto';
import { minimumGeneratedLength } from '../../state/skarbiec-records.js';

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
  const length = minimumGeneratedLength();
  if (length === null) {
    throw new Error(
      'Weles generates account passwords at the length the vault policy states, and it states none: '
      + 'set it with `skarbiec policy-set min_generated_length <length>`',
    );
  }
  if (length < classes.length) {
    throw new Error(
      `the vault policy's min_generated_length ${length} is shorter than the ${classes.length} character classes a password carries one of each`,
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
