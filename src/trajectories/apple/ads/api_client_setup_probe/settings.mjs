// The environment the Apple Ads API setup probe runs with.
import { runOutputPath } from '#run-output';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'apple_ads');
export const PUBLIC_KEY_PATH = process.env.ASC_ADS_PUBLIC_KEY_PATH || join(homedir(), '.apple-ads', 'public-key.pem');
export const PRIVATE_KEY_PATH = process.env.ASC_ADS_PRIVATE_KEY_PATH || join(homedir(), '.apple-ads', 'private-key.pem');
export const DIAG_DIR = process.env.APPLE_ADS_DIAG_DIR || runOutputPath('apple-ads-api-setup');
export const KEEP_OPEN_AFTER_LOGIN_MS = Number(process.env.APPLE_ADS_KEEP_OPEN_AFTER_LOGIN_MS || 0);
export const CLOSE_AFTER_PROBE = process.env.APPLE_ADS_CLOSE_AFTER_PROBE === '1';
mkdirSync(USER_DATA_DIR, { recursive: true });
mkdirSync(DIAG_DIR, { recursive: true });
process.env.WELES_VIEWPORT ??= '1440x1000';

