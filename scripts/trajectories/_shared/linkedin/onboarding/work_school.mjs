// Post-register profile-build helper.
//
// LinkedIn shows a mandatory onboarding gate after signup:
//   "<First>, you're one step away from viewing this profile —
//    Add a job or school to continue and get discovered by recruiters."
// with tabs "Add a role" / "Add a school" + required Title + Company inputs.
//
// Without filling this, the fresh stooge cannot view any other profile and
// scrapes return the gated stub. Call this from linkedin_register.mjs after
// post-signup redirect completes and before saveAccount/PASS.

import { humanFill, humanType } from '../../../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { ROLE_TITLES, ROLE_COMPANIES } from './stooge_data.mjs';

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function clickIfVisible(page, locator) {
  let visible = false;
  try { visible = await locator.isVisible(); } catch (e) { console.log(`[onboarding] isVisible err: ${e.message?.slice(0, 80)}`); return false; }
  if (!visible) return false;
  await humanClickLocator(page, locator);
  return true;
}

async function fillIfVisible(page, locator, value) {
  let visible = false;
  try { visible = await locator.isVisible(); } catch (e) { console.log(`[onboarding] isVisible err: ${e.message?.slice(0, 80)}`); return false; }
  if (!visible) return false;
  await humanFill(page, locator, value);
  return true;
}

/**
 * Fill the inline "Add a role" / "Add a school" widget that LinkedIn presents
 * after register. Returns { roleAdded, schoolAdded, viewable }.
 */
export async function fillPostRegisterOnboarding(page) {
  console.log('[onboarding] post-register profile-build attempt');
  await humanIdlePause('deliberate');

  let roleAdded = false;
  const title = pick(ROLE_TITLES);
  const company = pick(ROLE_COMPANIES);
  try {
    await page.goto('https://www.linkedin.com/in/me/edit/position/new/', { waitUntil: 'domcontentloaded' });
    await humanIdlePause('long');
    const titleFilled = await fillIfVisible(page, page.locator('input[id*="title-typeahead" i], input[aria-label*="Title" i], input[id*="title" i]').first(), title);
    await humanIdlePause('short');
    const companyFilled = await fillIfVisible(page, page.locator('input[id*="company-typeahead" i], input[aria-label*="Company" i], input[name="companyName"]').first(), company);
    await humanIdlePause('short');
    await clickIfVisible(page, page.locator('div[role="listbox"] li, ul[role="listbox"] li').first());
    await humanIdlePause('short');
    const saved = await clickIfVisible(page, page.locator('button:has-text("Save"), button:has-text("Add to my profile"), button[type="submit"]:has-text("Save")').first());
    if (titleFilled && companyFilled && saved) {
      roleAdded = true;
      console.log(`[onboarding] role added: ${title} @ ${company}`);
    } else {
      console.log(`[onboarding] role fill incomplete title=${titleFilled} company=${companyFilled} saved=${saved}`);
    }
  } catch (e) { console.log(`[onboarding] role err: ${e.message?.slice(0, 100)}`); }

  await humanIdlePause('deliberate');

  let schoolAdded = false;
  try {
    await page.goto('https://www.linkedin.com/in/me/edit/education/new/', { waitUntil: 'domcontentloaded' });
    await humanIdlePause('long');
    const schoolFilled = await fillIfVisible(page, page.locator('input[id*="school-typeahead" i], input[id*="school" i], input[aria-label*="School" i]').first(), 'Stanford University');
    await humanIdlePause('short');
    await clickIfVisible(page, page.locator('div[role="listbox"] li, ul[role="listbox"] li').first());
    await humanIdlePause('short');
    await fillIfVisible(page, page.locator('input[id*="degree" i], input[aria-label*="Degree" i]').first(), 'Bachelor of Science (BS)');
    await humanIdlePause('short');
    await fillIfVisible(page, page.locator('input[id*="fieldOfStudy" i], input[aria-label*="Field of study" i], input[id*="field" i]').first(), 'Computer Science');
    await humanIdlePause('short');
    const saved = await clickIfVisible(page, page.locator('button:has-text("Save"), button[type="submit"]:has-text("Save")').first());
    if (schoolFilled && saved) {
      schoolAdded = true;
      console.log('[onboarding] school added: Stanford University');
    } else {
      console.log(`[onboarding] school fill incomplete school=${schoolFilled} saved=${saved}`);
    }
  } catch (e) { console.log(`[onboarding] school err: ${e.message?.slice(0, 100)}`); }

  let viewable = false;
  try {
    await page.goto('https://www.linkedin.com/in/williamhgates/', { waitUntil: 'domcontentloaded' });
    await humanIdlePause('long');
    let body = '';
    try { body = await page.evaluate(() => document.body.innerText.slice(0, 4000)); }
    catch (e) { console.log(`[onboarding] body read err: ${e.message?.slice(0, 80)}`); }
    const gated = /one step away from viewing|complete one quick step|Add a job or school to continue/i.test(body);
    viewable = !gated && body.length > 500;
    console.log(`[onboarding] post-build profile view: gated=${gated} bodyLen=${body.length} viewable=${viewable}`);
  } catch (e) { console.log(`[onboarding] view-verify err: ${e.message?.slice(0, 100)}`); }

  return { roleAdded, schoolAdded, viewable };
}

void humanType;
