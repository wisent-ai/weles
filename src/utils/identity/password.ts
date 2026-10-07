import { randomInt, randomUUID } from 'node:crypto';
import { minimumGeneratedLength } from '../../state/skarbiec-records.js';

// Sign-up forms check for one character of each class; base64url alone has
// no character TikTok counts as special. Look-alike characters are left out
// so a password read back from a screen is the one typed.
const CHARACTER_CLASSES = Object.freeze([
  'ABCDEFGHJKLMNPQRSTUVWXYZ',
  'abcdefghijkmnpqrstuvwxyz',
  '23456789',
  '!@#$%&*',
]);

/**
 * A password for a new account Weles registers: one character of every
 * class, the rest from all of them, shuffled, at the length the vault's
 * policy states (`skarbiec policy-set min_generated_length <N>`). Each
 * registration used to choose its own length (eight, twelve, sixteen or
 * eighteen characters); now the operator states it once, where Skarbiec
 * checks every generated secret against it.
 */
export function registrationPassword(): string {
  const length = minimumGeneratedLength();
  if (length === null) {
    throw new Error(
      'Weles generates account passwords at the length the vault policy states, and it states none: '
      + 'set it with `skarbiec policy-set min_generated_length <length>`',
    );
  }
  if (length < CHARACTER_CLASSES.length) {
    throw new Error(
      `the vault policy's min_generated_length ${length} is shorter than the ${CHARACTER_CLASSES.length} character classes a password carries one of each`,
    );
  }
  const pick = (characters: string) => characters[randomInt(characters.length)];
  const everything = CHARACTER_CLASSES.join('');
  const characters = [
    ...CHARACTER_CLASSES.map(pick),
    ...Array.from({ length: length - CHARACTER_CLASSES.length }, () => pick(everything)),
  ];
  return characters
    .map((character) => ({ character, order: randomUUID() }))
    .sort((a, b) => a.order.localeCompare(b.order))
    .map(({ character }) => character)
    .join('');
}
