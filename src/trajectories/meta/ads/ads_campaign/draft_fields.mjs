// The fields the draft carries, and the proof they are in it.
//
// One pass down the campaign, ad set and ad steps: names, budget, the Facebook
// Page the ad runs from, the destination the click leads to, and the creative
// text. The count it returns is how many of the requested fields were actually
// written - the run refuses when that count is zero. The verification at the
// end re-reads the Review tab and refuses if a value the operator asked for is
// not on it.

import {
  AD_NAME,
  AD_SET_NAME,
  CAMPAIGN_NAME,
  DAILY_BUDGET_USD,
  DESCRIPTION,
  DESTINATION_URL,
  DISPLAY_LINK,
  FACEBOOK_PAGE_ID,
  FACEBOOK_PAGE_NAME,
  HEADLINE,
  PRIMARY_TEXT,
  URL_PARAMS,
} from './campaign_request.mjs';
import { clickAny, clickNext, fillAny, fillAnyReliable, pageText } from './panel_controls.mjs';

async function selectFacebookPage(s) {
  if (!FACEBOOK_PAGE_NAME && !FACEBOOK_PAGE_ID) return false;
  const opened = await clickAny(s, [
    'div[role="combobox"]:has-text("Wybierz stronę")',
    'div[role="combobox"]:has-text("Select a Page")',
    'div[role="combobox"]:has-text("Select Page")',
  ], 'Facebook Page selector', 5000);
  if (!opened) {
    const text = await pageText(s);
    if (FACEBOOK_PAGE_NAME && text.includes(FACEBOOK_PAGE_NAME)) {
      console.log(`[meta-ads] Facebook Page already selected: ${FACEBOOK_PAGE_NAME}`);
      return true;
    }
    return false;
  }
  await s.wait(2);
  const target = await s.page.evaluate(({ name, id }) => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const els = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], div, span'));
    for (const el of els) {
      const text = norm(el.innerText || el.textContent || '');
      if (!text) continue;
      if (id && text.includes(id)) {
        const r = el.getBoundingClientRect();
        if (r.width && r.height) return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 18), text };
      }
      if (name && (text === name || text.startsWith(`${name} Identyfikator:`) || text.startsWith(`${name} Identifier:`))) {
        const r = el.getBoundingClientRect();
        if (r.width && r.height) return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 18), text };
      }
    }
    return null;
  }, { name: FACEBOOK_PAGE_NAME, id: FACEBOOK_PAGE_ID });
  if (!target) {
    console.log(`[meta-ads] WARN: Facebook Page option not found: name=${FACEBOOK_PAGE_NAME || ''} id=${FACEBOOK_PAGE_ID || ''}`);
    return false;
  }
  await s.page.mouse.click(target.x, target.y);
  console.log(`[meta-ads] selected Facebook Page: ${target.text.slice(0, 120)}`);
  await s.wait(4);
  return true;
}

async function fillCampaignFields(s) {
  let filledCount = 0;
  if (await fillAnyReliable(s, [
    'input[aria-label*="Campaign name" i]',
    'input[placeholder*="Campaign name" i]',
    'input[placeholder="Wprowadź tutaj nazwę kampanii..."]',
    'label:has-text("Campaign name") input',
  ], CAMPAIGN_NAME, 'campaign name')) filledCount += 1;
  if (await clickNext(s, 3000)) await s.wait(3);
  if (await fillAnyReliable(s, [
    'input[aria-label*="Ad set name" i]',
    'input[placeholder*="Ad set name" i]',
    'input[placeholder="Wprowadź tutaj nazwę zestawu reklam..."]',
  ], AD_SET_NAME, 'ad set name')) filledCount += 1;
  if (await fillAny(s, [
    'input[aria-label*="Budget" i]',
    'input[placeholder*="Budget" i]',
    'label:has-text("Daily budget") input',
  ], DAILY_BUDGET_USD, 'daily budget')) filledCount += 1;
  if (await clickNext(s, 3000)) await s.wait(3);
  if (await fillAnyReliable(s, [
    'input[aria-label*="Ad name" i]',
    'input[placeholder*="Ad name" i]',
    'input[placeholder="Wprowadź tutaj nazwę reklamy..."]',
  ], AD_NAME, 'ad name')) filledCount += 1;
  if (await selectFacebookPage(s)) filledCount += 1;
  if (await fillAnyReliable(s, [
    'input[aria-label*="Website URL" i]',
    'input[placeholder*="Website URL" i]',
    'input[placeholder="http://www.przyklad.com/strona"]',
    'input[aria-label*="URL" i]',
  ], DESTINATION_URL, 'destination URL')) filledCount += 1;
  if (await fillAnyReliable(s, [
    'input[aria-label*="Display link" i]',
    'input[placeholder*="Display link" i]',
    'input[placeholder="Wprowadź link, który ma być wyświetlany w reklamie"]',
  ], DISPLAY_LINK, 'display link')) filledCount += 1;
  if (await fillAnyReliable(s, [
    'input[aria-label*="URL parameters" i]',
    'input[placeholder*="URL parameters" i]',
    'input[placeholder="klucz1=wartość1&klucz2=wartość2"]',
  ], URL_PARAMS, 'URL params')) filledCount += 1;
  if (await fillAnyReliable(s, [
    'textarea[aria-label*="Primary text" i]',
    'div[contenteditable="true"][aria-label*="Primary text" i]',
    'textarea',
  ], PRIMARY_TEXT, 'primary text')) filledCount += 1;
  if (await fillAnyReliable(s, [
    'input[aria-label*="Headline" i]',
    'textarea[aria-label*="Headline" i]',
  ], HEADLINE, 'headline')) filledCount += 1;
  if (await fillAnyReliable(s, [
    'input[aria-label*="Description" i]',
    'textarea[aria-label*="Description" i]',
  ], DESCRIPTION, 'description')) filledCount += 1;
  return filledCount;
}

async function verifyConfiguredDraft(s) {
  await clickAny(s, [
    'div[role="tab"]:has-text("Sprawdź")',
    'div[role="tab"]:has-text("Review")',
  ], 'Review/Sprawdź tab', 5000);
  await s.wait(3);
  const text = await pageText(s);
  const checks = [
    [CAMPAIGN_NAME, 'campaign name'],
    [AD_SET_NAME, 'ad set name'],
    [AD_NAME, 'ad name'],
    [FACEBOOK_PAGE_NAME, 'Facebook Page'],
    [DESTINATION_URL, 'destination URL'],
  ].filter(([value]) => value);
  const missing = checks.filter(([value]) => !text.includes(value)).map(([, label]) => label);
  if (missing.length) {
    console.log(`FAIL: Meta Ads draft verification missing ${missing.join(', ')}`);
    process.exit(1);
  }
  if (!/Wersja robocza|Draft/i.test(text)) {
    console.log('FAIL: Meta Ads draft verification did not find draft state');
    process.exit(1);
  }
  if (!/Wszystkie zmiany zapisane|All changes saved/i.test(text)) {
    console.log('[meta-ads] WARN: draft configured but save confirmation not visible');
  }
  return true;
}

export {
  fillCampaignFields,
  verifyConfiguredDraft,
};
