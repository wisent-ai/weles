// The environment the Accounts Center phone step runs with.
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'meta_ads');
export const WAIT_MS = Number(process.env.WAIT_MS || 3000);
export const VERIFY_PHONE = process.env.META_VERIFY_PHONE || '';
export const VERIFY_CODE = process.env.META_VERIFY_CODE || '';
export const CODE_ONLY = process.env.META_VERIFY_CODE_ONLY === '1';
if (!VERIFY_PHONE) {
  console.log('FAIL: META_VERIFY_PHONE is required');
  process.exit(1);
}
mkdirSync(USER_DATA_DIR, { recursive: true });
process.env.WELES_VIEWPORT ??= '1280x900';
