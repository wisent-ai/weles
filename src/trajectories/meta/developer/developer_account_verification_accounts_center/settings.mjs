// The environment the developer verification runs with. The phone is a live binding: main
// may replace it with the one the account already carries, through setVerifyPhone.
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'meta_ads');
export const WAIT_MS = Number(process.env.WAIT_MS || 3000);
export let VERIFY_PHONE = process.env.META_VERIFY_PHONE || '';
export const VERIFY_CODE = process.env.META_VERIFY_CODE || '';
export const CODE_ONLY = process.env.META_VERIFY_CODE_ONLY === '1';
export const OPEN_UPDATE_PHONE = process.env.META_VERIFY_OPEN_UPDATE_PHONE === '1';
export const VERIFY_PHONE_FROM_ACCOUNT_COUNTRY = process.env.META_VERIFY_PHONE_FROM_ACCOUNT_COUNTRY || '';
mkdirSync(USER_DATA_DIR, { recursive: true });
process.env.WELES_VIEWPORT ??= '1280x900';
export function setVerifyPhone(value) { VERIFY_PHONE = value; }
