// The environment a Google Ads campaign submission arrives as.
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ADS_URL = process.env.ADS_URL;
export const CUSTOMER_ID = process.env.GOOGLE_ADS_CUSTOMER_ID;
export const CAMPAIGN_NAME = process.env.CAMPAIGN_NAME || `Wisent ${new Date().toISOString().slice(0, 19)}`;
export const CAMPAIGN_TYPE = process.env.CAMPAIGN_TYPE || 'Search';
export const APP_ID = process.env.APP_ID;
export const PACKAGE_NAME = process.env.PACKAGE_NAME;
export const APP_NAME = process.env.APP_NAME;
export const APP_PLATFORM = process.env.APP_PLATFORM || process.env.PLATFORM;
export const IS_APP_INSTALL = /app/i.test(process.env.CAMPAIGN_OBJECTIVE || '')
  || /app/i.test(process.env.CAMPAIGN_TYPE || '')
  || !!(APP_ID || PACKAGE_NAME || APP_NAME);
export const CAMPAIGN_OBJECTIVE = process.env.CAMPAIGN_OBJECTIVE || (IS_APP_INSTALL ? 'App promotion' : 'Website traffic');
export const EFFECTIVE_CAMPAIGN_TYPE = process.env.CAMPAIGN_TYPE || (IS_APP_INSTALL ? 'App' : 'Search');
export const DAILY_BUDGET_USD = process.env.DAILY_BUDGET_USD;
export const FINAL_URL = process.env.FINAL_URL || process.env.DESTINATION_URL;
export const HEADLINE = process.env.HEADLINE;
export const DESCRIPTION = process.env.DESCRIPTION;
export const KEYWORDS = process.env.KEYWORDS;
export const LOCATIONS = process.env.LOCATIONS;
export const SUBMIT = process.env.SUBMIT === '1';
export const WAIT_FOR_LOGIN = process.env.WAIT_FOR_LOGIN === '1';
export const LOGIN_WAIT_MS = Number(process.env.LOGIN_WAIT_MS || 10 * 60 * 1000);
export const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || 60 * 1000);
export const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'google_ads');
mkdirSync(USER_DATA_DIR, { recursive: true });
process.env.WELES_VIEWPORT ??= '1280x900';
process.env.WELES_DISABLE_RECORDING ??= '1';
process.env.WELES_NO_INSTRUMENT ??= '1';
