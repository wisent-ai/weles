// The environment the Apple Ads report harvest runs with.
import { runOutputPath } from '#run-output';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'apple_ads');
export const DIAG_DIR = process.env.APPLE_ADS_DIAG_DIR || runOutputPath('apple-ads-report-harvest');
export const APP_ID = process.env.APPLE_ADS_APP_ID || process.env.APPLE_ADS_UI_APP_ID || '19768040';
export const SESSION_LABEL = process.env.APPLE_ADS_SESSION_LABEL || 'apple_ads_report_harvest';
export const REPORT_URL = process.env.APPLE_ADS_REPORT_URL || `https://app-ads.apple.com/cm/app/${APP_ID}/report`;
export const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || 90000);
export const WAIT_AFTER_NAV_MS = Number(process.env.APPLE_ADS_REPORT_WAIT_MS || 10000);
export const CLOSE_AFTER_HARVEST = process.env.APPLE_ADS_CLOSE_AFTER_HARVEST === '1';
export const KEEP_OPEN_AFTER_HARVEST_MS = Number(process.env.APPLE_ADS_KEEP_OPEN_AFTER_HARVEST_MS || 0);
export const DATE_PRESETS = (process.env.APPLE_ADS_DATE_PRESETS || 'Last 30 days,Last 12 weeks,Last 3 Calendar months')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
export const EXACT_RANGES = (process.env.APPLE_ADS_EXACT_RANGES || [
  'Initial=2025-12-02..2025-12-13',
  'Initial_copy=2026-01-19..2026-01-31',
  'all_active_campaign_dates=2025-12-02..2026-01-31',
].join(','))
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => {
    const [label, range] = value.split('=');
    const [startTime, endTime] = String(range || '').split('..');
    return { label: label || `${startTime}_${endTime}`, startTime, endTime };
  })
  .filter((range) => /^\d{4}-\d{2}-\d{2}$/.test(range.startTime || '') && /^\d{4}-\d{2}-\d{2}$/.test(range.endTime || ''));

process.env.WELES_CAPTURE_RESPONSE_BODIES ??= '1';
process.env.WELES_DISABLE_RECORDING ??= '1';
process.env.WELES_NO_INSTRUMENT ??= '1';
process.env.WELES_VIEWPORT ??= '1440x1000';

mkdirSync(USER_DATA_DIR, { recursive: true });
mkdirSync(DIAG_DIR, { recursive: true });
