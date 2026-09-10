// The Google Authenticator code this driver answers a 2FA prompt with, and the
// reading of the secret it is computed from.
//
// A scoped login carries that secret under one of several key names, sometimes
// nested in a metadata document, sometimes as a whole otpauth:// URI. So
// resolving it is a search over the credential document, and generating the code
// is RFC 6238 with the parameters Google's authenticator uses: SHA1, six digits,
// a thirty-second step.
import { createHmac } from 'node:crypto';

function extractTotpSecretFromValue(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^otpauth:\/\//i.test(text)) {
    // A value that declares itself an otpauth URI and then carries no secret is
    // a broken credential, not an account without a secret: say so instead of
    // reading it as an empty secret and searching on.
    const secret = new URL(text).searchParams.get('secret');
    if (secret === null) throw new Error('otpauth URI carries no secret parameter');
    return secret;
  }
  return text;
}

function findTotpSecret(value, seen = new Set()) {
  if (!value || seen.has(value)) return '';
  if (typeof value === 'string') return extractTotpSecretFromValue(value);
  if (typeof value !== 'object') return '';
  seen.add(value);

  const preferredKeys = [
    'totp_secret',
    'totpSecret',
    'otp_secret',
    'otpSecret',
    'authenticator_secret',
    'authenticatorSecret',
    'google_totp_secret',
    'googleTotpSecret',
    'google_authenticator_secret',
    'googleAuthenticatorSecret',
    'mfa_secret',
    'mfaSecret',
    'two_factor_secret',
    'twoFactorSecret',
  ];
  for (const key of preferredKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const secret = extractTotpSecretFromValue(value[key]);
      if (secret) return secret;
    }
  }
  for (const nestedKey of ['metadata', 'meta', 'credentials', 'secrets', 'login_metadata']) {
    if (value[nestedKey]) {
      const secret = findTotpSecret(value[nestedKey], seen);
      if (secret) return secret;
    }
  }
  return '';
}

export function resolveTotpSecret(creds) {
  return findTotpSecret(creds);
}

function decodeBase32Secret(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = extractTotpSecretFromValue(secret).toUpperCase().replace(/[\s=-]/g, '');
  if (!clean) throw new Error('empty TOTP secret');
  let bits = '';
  for (const char of clean) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error(`invalid TOTP base32 character ${char}`);
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

export function generateTotp(secret, options = {}) {
  const digits = Number(options.digits || 6);
  const step = Number(options.step || 30);
  const algorithm = String(options.algorithm || 'sha1').toLowerCase();
  const counter = Math.floor((options.now || Date.now()) / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac(algorithm, decodeBase32Secret(secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}
