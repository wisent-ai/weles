/**
 * Shared identity generation using faker — no hardcoded data.
 * Single source for all identity fields across tools.ts and wsession.ts.
 */

import { randomBytes } from 'node:crypto';

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
  const domain = process.env.AGENT_DOMAIN ?? 'wisentmedia.com';
  const email = `${username}@${domain}`;
  const password = randomBytes(12).toString('base64url').slice(0, 16);
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
