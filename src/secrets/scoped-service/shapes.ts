// The shape a captured value must have before it is committed, per contract
// kind: password complexity, provider token prefixes, and the opaque-token
// bounds.
//
// Moved verbatim out of the single scoped-service file during a split by
// responsibility.

import { resolvedAcquiredSecretContract, type WelesAcquiredSecret } from './contracts';

function isAllowedCredentialByte(byte: number): { allowed: boolean; letter: boolean; digit: boolean } {
  const digit = byte >= Number('48') && byte <= Number('57');
  const upper = byte >= Number('65') && byte <= Number('90');
  const lower = byte >= Number('97') && byte <= Number('122');
  const punctuation = byte === Number('46') || byte === Number('45') || byte === Number('95');
  return { allowed: digit || upper || lower || punctuation, letter: upper || lower, digit };
}

function hasPrefix(secret: Buffer, prefix: string): boolean {
  return secret.subarray(Number('0'), Buffer.byteLength(prefix)).equals(Buffer.from(prefix, 'ascii'));
}

function matchesPasswordShape(secret: Buffer): boolean {
  if (secret.length < Number('20') || secret.length > Number('128')) return false;
  let upper = false;
  let lower = false;
  let digit = false;
  let symbol = false;
  for (const byte of secret) {
    if (byte < Number('33') || byte > Number('126') || byte === Number('34') || byte === Number('92')) {
      return false;
    }
    upper ||= byte >= Number('65') && byte <= Number('90');
    lower ||= byte >= Number('97') && byte <= Number('122');
    digit ||= byte >= Number('48') && byte <= Number('57');
    symbol ||= !(
      (byte >= Number('65') && byte <= Number('90'))
      || (byte >= Number('97') && byte <= Number('122'))
      || (byte >= Number('48') && byte <= Number('57'))
    );
  }
  return upper && lower && digit && symbol;
}

function matchesAcquiredSecretShape(shape: string, secret: Buffer): boolean {
  if (shape === 'password') return matchesPasswordShape(secret);
  if (secret.length < Number('16') || secret.length > Number('8192')) return false;
  let hasLetter = false;
  let hasDigit = false;
  for (const byte of secret) {
    const kind = isAllowedCredentialByte(byte);
    if (!kind.allowed) return false;
    hasLetter ||= kind.letter;
    hasDigit ||= kind.digit;
  }
  if (shape === 'semantic-scholar') {
    return secret.length >= Number('20') && secret.length <= Number('128') && hasLetter && hasDigit;
  }
  if (shape === 'github') {
    return secret.length >= Number('24')
      && (hasPrefix(secret, 'github_pat_')
        || hasPrefix(secret, 'ghp_')
        || hasPrefix(secret, 'gho_')
        || hasPrefix(secret, 'ghu_')
        || hasPrefix(secret, 'ghs_')
        || hasPrefix(secret, 'ghr_'));
  }
  if (shape === 'opaque-token') {
    return secret.length >= Number('20') && secret.length <= Number('8192') && hasLetter && hasDigit;
  }
  return shape === 'supabase' && secret.length >= Number('16') && hasPrefix(secret, 'sbp_');
}

export function isWelesAcquiredSecretValue(secretName: WelesAcquiredSecret, secret: Buffer): boolean {
  const contract = resolvedAcquiredSecretContract(secretName);
  return Boolean(contract && matchesAcquiredSecretShape(contract.shape, secret));
}
