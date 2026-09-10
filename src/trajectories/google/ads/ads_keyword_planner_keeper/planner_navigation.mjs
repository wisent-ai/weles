// Getting from wherever the keeper's tab happens to be to the Keyword Planner
// form for this customer: the product's own planner addresses (plus any planner
// address earlier runs recorded), the account picker Google puts in front of a
// multi-account login, and the one control that opens the keyword entry box.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DIAG_DIR, RESULT_FILE, cid, dashedCustomerId, norm, preferredEmail } from './run_brief.mjs';
import { clickControl, dismissChrome, evalState, fillKeywordInput, idle, nav } from './keeper_browser.mjs';
import { handleGoogleLogin } from './google_login.mjs';

const PLANNER_READY = /Discover new keywords|Get search volume|forecasts?|Avg\.? monthly searches|Saved keywords|Enter or paste your keywords/i;

function adsUrl(pathname) {
  const url = new URL(pathname, 'https://ads.google.com');
  url.searchParams.set('cid', cid);
  url.searchParams.set('authuser', process.env.GOOGLE_ADS_AUTHUSER || '1');
  return url.toString();
}

function savedPlannerUrls() {
  const files = [
    RESULT_FILE,
    join(DIAG_DIR, `keywords-${cid}.json`),
    ...readdirSync(DIAG_DIR).filter((name) => name.endsWith('.json')).map((name) => join(DIAG_DIR, name)),
  ];

  const urls = [];
  for (const file of [...new Set(files)]) {
    if (!existsSync(file)) continue;
    const record = JSON.parse(readFileSync(file, 'utf8'));
    for (const candidate of [record?.url, record?.report?.url, record?.browser?.report?.url]) {
      if (/^https:\/\/ads\.google\.com\/aw\/keywordplanner\//i.test(candidate || '')) urls.push(candidate);
    }
  }
  return [...new Set(urls)];
}

function plannerCandidates(paths) {
  return [...paths.map((path) => adsUrl(path)), ...savedPlannerUrls()];
}

export async function selectGoogleAdsAccount() {
  const s = await evalState(6000);
  const text = s.text || '';
  if (!/Select a Google Ads account|Select an active account|No account|Google Ads account/i.test(text)) return true;
  const accountRow = [
    dashedCustomerId(cid).replace(/-/g, '[- ]?'),
    cid,
    preferredEmail().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  ].join('|');
  if (!await clickControl(accountRow, 'Google Ads account', { maxArea: 500_000 }).catch(() => false)) return false;
  for (let i = 0; i < 12; i += 1) {
    await idle('short');
    const after = await evalState(4000);
    if (!/selectaccount/i.test(after.url || '') && !/Select a Google Ads account|Select an active account/i.test(after.text || '')) return true;
  }
  return false;
}

export async function ensureAdsReady(creds) {
  for (const url of plannerCandidates(['/aw/keywordplanner/ideas/new', '/aw/keywordplanner/ideas', '/aw/keywordplanner', '/aw/campaigns'])) {
    await nav(url);
    const current = await evalState(6000);
    if (/accounts\.google\.com/i.test(current.url || '')) {
      if (!await handleGoogleLogin(creds)) return false;
      await nav(url);
    }
    const after = await evalState(6000);
    if (/Google Ads 2-step verification required/i.test(after.text || '') && !/\/aw\/campaigns/i.test(url)) continue;
    if (/selectaccount/i.test(after.url || '') || /Select a Google Ads account|Select an active account|Google Ads account/i.test(after.text || '')) {
      if (await selectGoogleAdsAccount()) return true;
      continue;
    }
    if (/Keyword Planner|Discover new keywords|Get search volume|Campaigns|Create campaign/i.test(after.text || '')) {
      return await selectGoogleAdsAccount();
    }
  }
  return false;
}

export async function openKeywordPlanner() {
  for (const url of plannerCandidates(['/aw/keywordplanner/ideas/new', '/aw/keywordplanner/ideas', '/aw/keywordplanner', '/aw/keywordplanner/home'])) {
    await nav(url);
    await selectGoogleAdsAccount();
    await dismissChrome();
    let s = await evalState(9000);
    for (let i = 0; i < 12 && !PLANNER_READY.test(s.text || ''); i += 1) {
      await idle('short');
      s = await evalState(9000);
    }
    if (PLANNER_READY.test(s.text || '')) {
      return { ok: true, path: url, url: s.url, textPreview: norm(s.text).slice(0, 1000) };
    }
  }
  const s = await evalState(4000);
  return { ok: false, url: s.url, textPreview: norm(s.text).slice(0, 1200) };
}

async function keywordInputVisible() {
  const s = await evalState(7000);
  return s.inputs.some((input) => input.visible && /keyword|phrase|service|paste/i.test(`${input.aria} ${input.placeholder} ${input.tag}`) && !/website|domain|url/i.test(`${input.aria} ${input.placeholder}`));
}

// One control opens the keyword box, and the planner labels it differently on
// the ideas page and on the planner home card. Both labels are searched at once
// and the smallest visible match wins, so the compact "Add keywords" button is
// preferred over the large card exactly as before.
export async function chooseVolumeMode() {
  if (await keywordInputVisible()) return true;
  await dismissChrome();
  if (await clickControl('Add keywords|Get search volume and forecasts|Get search volume|forecasts', 'keyword entry control', { minY: 100, maxY: 650, maxArea: 800_000 })) {
    await idle('deliberate');
  }
  return await keywordInputVisible();
}

export async function submitKeywords() {
  await fillKeywordInput();
  await dismissChrome();
  return await clickControl('^Save$|Get started|Get results|See results|View results|^Search$', 'planner submit', { minY: 180, maxY: 760, maxArea: 80_000 }).catch(() => false);
}
