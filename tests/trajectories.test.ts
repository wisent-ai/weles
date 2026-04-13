/**
 * Integration tests — FetchAccountValue against real dashboard sites.
 *
 * Requirements:
 *   Playwright browsers installed (npx playwright install chromium)
 *   Service credentials in env vars (e.g. OXYLABS_EMAIL, OXYLABS_PASSWORD)
 *
 * Run:  npx vitest run tests/trajectories.test.ts
 */

import { describe, it, expect } from 'vitest';
import { FetchAccountValue } from '../src/agent/tasks.js';

const FIVE_MINUTES = 5 * 60 * 1000;

const DASHBOARDS: Array<{
  service: string;
  url: string;
  what: string;
  usernameEnv: string;
  passwordEnv: string;
}> = [
  { service: 'oxylabs', url: 'https://dashboard.oxylabs.io', what: 'the traffic usage or account balance', usernameEnv: 'OXYLABS_EMAIL', passwordEnv: 'OXYLABS_PASSWORD' },
  { service: 'brightdata', url: 'https://brightdata.com/cp', what: 'the current account credit balance in USD', usernameEnv: 'BRIGHTDATA_EMAIL', passwordEnv: 'BRIGHTDATA_PASSWORD' },
  { service: 'anticaptcha', url: 'https://anti-captcha.com/clients', what: 'the current account balance in USD', usernameEnv: 'ANTICAPTCHA_EMAIL', passwordEnv: 'ANTICAPTCHA_PASSWORD' },
  { service: 'packetstream', url: 'https://app.packetstream.io', what: 'the current account balance in USD', usernameEnv: 'PACKETSTREAM_EMAIL', passwordEnv: 'PACKETSTREAM_PASSWORD' },
  { service: 'capsolver', url: 'https://dashboard.capsolver.com', what: 'the current account balance in USD', usernameEnv: 'CAPSOLVER_EMAIL', passwordEnv: 'CAPSOLVER_PASSWORD' },
  { service: 'twocaptcha', url: 'https://2captcha.com', what: 'the current account balance in USD', usernameEnv: 'TWOCAPTCHA_EMAIL', passwordEnv: 'TWOCAPTCHA_PASSWORD' },
  { service: 'pingproxies', url: 'https://dashboard.pingproxies.com', what: 'the current account balance or remaining traffic', usernameEnv: 'PINGPROXIES_EMAIL', passwordEnv: 'PINGPROXIES_PASSWORD' },
];

describe('FetchAccountValue — dashboards', () => {
  for (const d of DASHBOARDS) {
    const hasCredentials = !!(process.env[d.usernameEnv] && process.env[d.passwordEnv]);
    it.skipIf(!hasCredentials)(`${d.service}`, async () => {
      const value = await new FetchAccountValue(d).run();
      console.log(`${d.service} balance:`, value);
      expect(value).not.toBeNull();
      expect(typeof value).toBe('number');
    }, FIVE_MINUTES);
  }
});
