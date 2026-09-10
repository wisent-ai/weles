// Getting from the campaign table into a draft, and refusing with evidence
// when we never got there.
//
// Ads Manager opens on a table, not on a form. This module presses Create (or
// recognises that ADS_URL already put us inside a draft), picks the objective,
// walks the campaign-setup step that sometimes appears in between, and - when
// the form never appeared - prints the controls that were on screen instead so
// the refusal can be read without a screenshot.

import { CAMPAIGN_NAME, objectiveLabels } from './campaign_request.mjs';
import { clickAny, clickPoint, clickVisibleTextInArea, pageText } from './panel_controls.mjs';

// URLSearchParams answers null for a parameter that is not in the address, so
// that answer is passed through as it is.
function selectedCampaignId(url) {
  if (!URL.canParse(url)) return null;
  return new URL(url).searchParams.get('selected_campaign_ids');
}

async function maybeContinueCampaignConfiguration(s) {
  const text = await pageText(s);
  if (!/Wybierz konfigurację kampanii|Choose campaign setup|Ręcznie utworzona kampania|Zalecane ustawienia/i.test(text)) {
    return false;
  }
  await clickAny(s, [
    'div[role="button"]:has-text("Kontynuuj")',
    'button:has-text("Kontynuuj")',
    'div[role="button"]:has-text("Continue")',
    'button:has-text("Continue")',
  ], 'configuration Continue', 5000);
  await clickVisibleTextInArea(s, /^(Kontynuuj|Continue)$/i, 'configuration Continue', {
    minX: 760,
    maxX: 1100,
    minY: 500,
    maxY: 820,
    minW: 60,
    minH: 30,
  }, 4000);
  await s.wait(8);
  return true;
}

async function openCampaignCreation(s) {
  const startingDraftUrl = s.page.url?.() ?? '';
  let createClicked = /\/edit\/standalone/i.test(startingDraftUrl) && !!selectedCampaignId(startingDraftUrl);
  if (createClicked) {
    console.log(`[meta-ads] configuring existing draft campaign_id=${selectedCampaignId(startingDraftUrl)}`);
  }
  if (!createClicked) createClicked = await clickAny(s, [
    'div[role="toolbar"] div[role="button"]:has-text("Create")',
    'div[role="toolbar"] div[role="button"]:has-text("Utwórz")',
    'div[role="toolbar"] button:has-text("Create")',
    'div[role="toolbar"] button:has-text("Utwórz")',
  ], 'campaign Create', 8000) || await clickVisibleTextInArea(s, /^(\+ )?(Create|Utwórz)$/i, 'campaign Create', {
    minX: 40,
    maxX: 220,
    minY: 120,
    maxY: 230,
    minW: 80,
    minH: 35,
  }, 8000) || await clickAny(s, [
    'div[role="button"]:has-text("Create")',
    'div[role="button"]:has-text("Utwórz")',
    'button:has-text("Create")',
    'button:has-text("Utwórz")',
    '[aria-label="Create"]',
    '[aria-label="Utwórz"]',
  ], 'Create', 12000);
  if (!createClicked) {
    createClicked = await clickPoint(s, 122, 233, 'campaign Create by coordinates');
    await s.wait(4);
  }
  return createClicked;
}

async function chooseObjectiveAndContinue(s) {
  if (/\/edit\/standalone/i.test(s.page.url?.() ?? '')) return;
  let objectiveClicked = false;
  for (const label of objectiveLabels) {
    if (await clickAny(s, [
      `div[role="radio"]:has-text("${label}")`,
      `label:has-text("${label}")`,
      `div[role="button"]:has-text("${label}")`,
      `div[role="dialog"] div:has-text("${label}")`,
      `text="${label}"`,
    ], `objective ${label}`, 3000)) {
      objectiveClicked = true;
      break;
    }
    if (await clickVisibleTextInArea(s, new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), `objective ${label}`, {
      minX: 250,
      maxX: 700,
      minY: 260,
      maxY: 650,
      minW: 20,
      minH: 12,
    }, 2000)) {
      objectiveClicked = true;
      break;
    }
  }
  if (!objectiveClicked) {
    const viewport = s.page.viewportSize?.() ?? { width: 1280, height: 900 };
    await clickPoint(s, Math.round(viewport.width * 0.36), 455, 'objective Traffic/Ruch by coordinates');
    await s.wait(1);
    objectiveClicked = true;
  }
  if (!objectiveClicked) console.log(`[meta-ads] WARN: objective not selected: ${objectiveLabels.join('/')}`);
  await clickAny(s, ['div[role="button"]:has-text("Continue")', 'button:has-text("Continue")'], 'Continue', 5000);
  const continued = await clickAny(s, ['div[role="button"]:has-text("Kontynuuj")', 'button:has-text("Kontynuuj")'], 'Kontynuuj', 5000);
  if (!continued) {
    const viewport = s.page.viewportSize?.() ?? { width: 1280, height: 900 };
    await clickPoint(s, Math.round(viewport.width * 0.68), 785, 'Kontynuuj by coordinates');
    await s.wait(4);
  }
  await maybeContinueCampaignConfiguration(s);
}

// Diagnostics for a refusal. Listing the controls can itself fail, so the
// answer says which of the two it is and the refusal keeps its own message
// either way.
async function visibleControlDebug(s) {
  try {
    return await s.page.evaluate(() => Array.from(document.querySelectorAll('button,[role="button"],[role="radio"],div,span,a'))
      .map((el) => {
        const r = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        const style = window.getComputedStyle(el);
        return {
          text: text.slice(0, 80),
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
          tag: el.tagName,
          role: el.getAttribute('role'),
          visible: !!r.width && !!r.height && style.display !== 'none' && style.visibility !== 'hidden',
        };
      })
      .filter((e) => e.visible && /Utwórz|Create|Ruch|Traffic|Kontynuuj|Continue|Przegląd konta|account/i.test(e.text))
      .slice(0, 80));
  } catch (error) {
    return { ok: false, reason: `visible controls could not be listed: ${error.message}` };
  }
}

// Never returns: either the draft is already staged and this is a PASS, or the
// run refuses. Exit code 2 marks the account-side blocks an operator has to
// clear by hand; 1 marks a form we simply did not reach.
async function reportDraftOutcomeWithoutFields(s, createClicked, filledCount) {
  const url = s.page.url?.() ?? '';
  const draftCampaignId = selectedCampaignId(url);
  const draftText = await pageText(s);
  if (createClicked && draftCampaignId && /Wersja robocza|Draft/i.test(draftText)) {
    console.log(`PASS: staged Meta ads campaign draft "${CAMPAIGN_NAME}" (SUBMIT=0, campaign_id=${draftCampaignId})`);
    process.exit(0);
  }
  if (/Potrzebne informacje o koncie|Needed account information|Przegląd konta|account review/i.test(draftText)) {
    console.log(`FAIL: Meta account setup/review blocks campaign draft creation (createClicked=${createClicked}, filled=${filledCount}, url=${s.page.url?.() ?? ''})`);
    process.exit(2);
  }
  const controls = await visibleControlDebug(s);
  console.log(`[meta-ads] visible controls debug: ${controls.ok === false ? controls.reason : JSON.stringify(controls).slice(0, 6000)}`);
  console.log(`FAIL: Meta Ads campaign form was not reached (createClicked=${createClicked}, filled=${filledCount}, url=${s.page.url?.() ?? ''})`);
  process.exit(1);
}

export {
  chooseObjectiveAndContinue,
  openCampaignCreation,
  reportDraftOutcomeWithoutFields,
};
