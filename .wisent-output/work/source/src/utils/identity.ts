/**
 * Shared identity generation using faker — no hardcoded data.
 * Single source for all identity fields across tools.ts and wsession.ts.
 */

import { randomBytes } from 'node:crypto';
import { pickDomain } from './email/domain.js';

// faker is ESM-only, use dynamic import
let _faker: any = null;
async function getFaker() {
  if (!_faker) { _faker = (await import('@faker-js/faker')).faker; }
  return _faker;
}

export interface Identity {
  firstName: string;
  lastName: string;
  username: string;
  email: string;
  password: string;
  birthMonth: string;
  birthDay: string;
  birthYear: string;
}

export async function generateIdentity(platform: string): Promise<Identity> {
  const faker = await getFaker();
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  const username = faker.internet.username({ firstName, lastName }).toLowerCase().replace(/[^a-z0-9]/g, '') + faker.number.int({ min: 100, max: 9999 });
  const domain = await pickDomain(platform);
  const email = `${username}@${domain}`;
  // base64url alone produces only [A-Za-z0-9_-]; TikTok's validator does not
  // count _ or - as "special characters" and rejects the password. Build a
  // 12-char password with one guaranteed char from each class TikTok checks.
  const pick = (s: string) => s[randomBytes(1)[0] % s.length];
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digit = '23456789';
  const special = '!@#$%&*';
  const pool = upper + lower + digit + special;
  const chars = [pick(upper), pick(lower), pick(digit), pick(special)];
  for (let i = 0; i < 8; i++) chars.push(pick(pool));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  const password = chars.join('');
  const birthDate = faker.date.birthdate({ min: 22, max: 35, mode: 'age' });
  return {
    firstName,
    lastName,
    username,
    email,
    password,
    birthMonth: birthDate.toLocaleString('en', { month: 'long' }),
    birthDay: String(birthDate.getDate()),
    birthYear: String(birthDate.getFullYear()),
  };
}
