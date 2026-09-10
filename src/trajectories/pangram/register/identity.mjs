import { randomBytes } from 'node:crypto';

function pickEmailDomain() {
  const domains = (process.env.PANGRAM_EMAIL_DOMAINS || 'wisentmedia.com')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return domains[Math.floor(Math.random() * domains.length)];
}

/** PANGRAM_EMAIL when set, else a service address on one of the configured domains. */
export function generateEmail() {
  if (process.env.PANGRAM_EMAIL) return process.env.PANGRAM_EMAIL;
  const domain = pickEmailDomain();
  const local = process.env.PANGRAM_EMAIL_LOCAL_PART || `svc.pangram.${randomBytes(4).toString('hex')}`;
  return `${local}@${domain}`;
}

/** PANGRAM_PASSWORD when set, else eighteen characters with one from every group, shuffled. */
export function registrationPassword() {
  if (process.env.PANGRAM_PASSWORD) return process.env.PANGRAM_PASSWORD;
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digit = '23456789';
  const special = '!@#$%&*';
  const all = upper + lower + digit + special;
  const pick = (s) => s[randomBytes(1)[0] % s.length];
  const out = [pick(upper), pick(lower), pick(digit), pick(special)];
  for (let i = 0; i < 14; i += 1) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomBytes(1)[0] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}
