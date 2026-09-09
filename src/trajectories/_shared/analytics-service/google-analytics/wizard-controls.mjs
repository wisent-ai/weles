import { humanFill } from '../../../../../dist/human/keyboard.js';
import { humanIdlePause } from '../../../../../dist/human/mouse.js';
import { defaultInput } from '../action-catalog.mjs';
import {
  escapeRegExp,
  bodyText,
  waitRendered,
  clickFirst,
  clickLocator,
  clickDirectLocator,
  clickAnyLocator,
  clickDomElement,
  activeStepPanel,
} from '../page-interaction.mjs';

async function selectedGaStep(page) {
  try {
    return await page.evaluate(() => {
      const visible = (node) => {
        const style = window.getComputedStyle(node);
        const box = node.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0;
      };
      const labels = Array.from(document.querySelectorAll('.mat-step-header[aria-selected="true"] .mat-step-text-label'));
      return labels.find((node) => visible(node))?.textContent?.replace(/\s+/g, ' ').trim() || '';
    });
  } catch (error) {
    throw new Error(`GA wizard selected step could not be read from ${page.url()}: ${error.message}`, { cause: error });
  }
}

async function waitForGaStep(page, pattern, description) {
  for (let i = 0; i < 50; i++) {
    const step = await selectedGaStep(page);
    if (pattern.test(step)) return;
    await humanIdlePause('short');
  }
  const step = await selectedGaStep(page);
  throw new Error(`${description} did not advance; selected_step=${JSON.stringify(step)}`);
}

async function waitForGaStepOrText(page, stepPattern, textPattern, description) {
  for (let i = 0; i < 50; i++) {
    const step = await selectedGaStep(page);
    const text = await bodyText(page);
    if (stepPattern.test(step) || textPattern.test(text)) return;
    await humanIdlePause('short');
  }
  const step = await selectedGaStep(page);
  const text = await bodyText(page);
  throw new Error(`${description} did not advance; selected_step=${JSON.stringify(step)}; body_preview=${text.slice(0, 500).replace(/\s+/g, ' ')}`);
}

function enabledButtonLocator(root, pattern) {
  return root
    .getByRole('button', { name: pattern })
    .or(root.locator('button, material-button, [role="button"], a[role="button"]').filter({ hasText: pattern }))
    .filter({ visible: true })
    .filter({ hasNot: root.locator('[disabled], [aria-disabled="true"]') });
}

async function dismissGoogleAnalyticsOverlays(page) {
  for (const selector of [
    'button[aria-label*="Close"]',
    '[role="button"][aria-label*="Close"]',
    'material-button.close',
    'button.close',
    '.close-button',
  ]) {
    await clickAnyLocator(page, [page.locator(selector)]).catch(() => false);
  }
  for (const labels of [
    [/^Close$/i, /Got it/i, /Dismiss/i],
    [/^Skip$/i, /No thanks/i, /Maybe later/i],
  ]) {
    await clickFirst(page, labels).catch(() => false);
  }
}

async function clickGaNext(page, description = 'GA wizard next button', expectedStepPattern = null) {
  await dismissGoogleAnalyticsOverlays(page);
  const pattern = /^(Next|Continue|Save|Create|Create and continue|Submit|I accept|Accept)$/i;
  const panel = activeStepPanel(page);
  const locators = [];
  if (await panel.isVisible().catch(() => false)) locators.push(enabledButtonLocator(panel, pattern));
  locators.push(enabledButtonLocator(page, pattern));
  if (!await clickAnyLocator(page, locators).catch(() => false)) {
    if (!await clickFirst(page, [/^Next$/i, /^Continue$/i, /^Save$/i, /^Create$/i, /^Create and continue$/i, /^Submit$/i, /^I accept$/i, /^Accept$/i]).catch(() => false)) {
      const text = await bodyText(page);
      const buttons = await page.locator('button, material-button, [role="button"], a[role="button"]')
        .filter({ visible: true })
        .evaluateAll((nodes) => nodes.map((node) => ({
          text: node.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          disabled: node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true',
        })).filter((item) => item.text).slice(-20))
        .then(
          (list) => list,
          (listError) => ({ listed: false, reason: `visible buttons could not be listed: ${listError.message}` }),
        );
      throw new Error(`${description} was not clickable; visible_buttons=${JSON.stringify(buttons)}; body_preview=${text.slice(0, 500).replace(/\s+/g, ' ')}`);
    }
  }
  if (expectedStepPattern) {
    await waitForGaStep(page, expectedStepPattern, description);
    return;
  }
  await waitRendered(page, 40);
}

async function selectVisibleChoice(page, candidates) {
  for (const candidate of candidates) {
    if (await clickFirst(page, [candidate]).catch(() => false)) return true;
  }
  const controls = page.locator('mat-radio-button, mat-checkbox, [role="radio"], [role="checkbox"], label, button').filter({ visible: true });
  const count = await controls.count();
  if (count > 0) {
    await clickLocator(page, controls.nth(0)).catch(() => false);
    return true;
  }
  return false;
}

async function setOptionalDropdown(page, labelPatterns, value) {
  if (!value) return false;
  for (const pattern of labelPatterns) {
    const control = page.getByLabel(pattern)
      .or(page.locator('mat-select, [role="combobox"], input').filter({ hasText: pattern }))
      .filter({ visible: true })
      .first();
    if (!await control.isVisible().catch(() => false)) continue;
    await clickLocator(page, control).catch(() => false);
    await humanIdlePause('short');
    const search = page.locator('input:not([type="hidden"])').filter({ visible: true }).last();
    if (await search.isVisible().catch(() => false)) {
      await humanFill(page, search, value);
      await humanIdlePause('short');
    }
    if (await clickDomElement(page, [
      '.cdk-overlay-container [debug-id="option-item"]',
      '.cdk-overlay-container [role="option"]',
      '.cdk-overlay-container mat-option',
      '.cdk-overlay-container button',
    ], new RegExp(escapeRegExp(value), 'i')).catch(() => false)) return true;
    await page.keyboard.press('Escape');
  }
  return false;
}

async function setGoogleAnalyticsIndustry(page) {
  const business = page.locator('ga-business-info').filter({ visible: true }).first();
  const trigger = business
    .locator('industry-selector button[debug-id="menu-open-button"], searchable-select[required] button[debug-id="menu-open-button"]')
    .filter({ visible: true })
    .first();
  if (!await clickDirectLocator(page, trigger).catch(() => false)) return false;
  await humanIdlePause('short');

  const search = page.locator('.cdk-overlay-container input:not([type="hidden"]), .cdk-overlay-container textarea')
    .filter({ visible: true })
    .first();
  if (await search.isVisible().catch(() => false)) {
    await humanFill(page, search, defaultInput('INDUSTRY_CATEGORY', 'Other'));
    await humanIdlePause('short');
  }

  const preferred = new RegExp(`^${escapeRegExp(defaultInput('INDUSTRY_CATEGORY', 'Other'))}$`, 'i');
  return await clickDomElement(page, [
    '.cdk-overlay-container [debug-id="option-item"]',
    '.cdk-overlay-container [role="menuitem"]',
    '.cdk-overlay-container [role="option"]',
    '.cdk-overlay-container button',
  ], preferred).catch(() => false)
    || await clickDomElement(page, [
      '.cdk-overlay-container [debug-id="option-item"]',
      '.cdk-overlay-container [role="menuitem"]',
      '.cdk-overlay-container [role="option"]',
      '.cdk-overlay-container button',
    ], /Other|Internet|Online|Technology|Community|Consumer/i).catch(() => false);
}

async function setGoogleAnalyticsBusinessSize(page) {
  const business = page.locator('ga-business-info').filter({ visible: true }).first();
  const value = defaultInput('BUSINESS_SIZE', '1');
  const sizeRadio = business.locator(`input[type="radio"][value="${escapeRegExp(value)}"]`).first();
  if (await sizeRadio.count()) {
    await sizeRadio.check({ force: true });
    await humanIdlePause('short');
    if (await sizeRadio.isChecked().catch(() => false)) return true;
  }
  return clickAnyLocator(page, [
    business.locator('label').filter({ hasText: /Small|1 to 10/i }),
    business.locator('mat-radio-button').filter({ hasText: /Small|1 to 10/i }),
    business.locator('label').filter({ hasText: /Medium|11 to 100/i }),
    business.locator('mat-radio-button').filter({ hasText: /Medium|11 to 100/i }),
  ]).catch(() => false);
}

async function setGoogleAnalyticsObjective(page) {
  const panel = activeStepPanel(page);
  const objective = defaultInput('BUSINESS_OBJECTIVE', 'Understand web and/or app traffic');
  const preferred = panel.locator(`input[type="checkbox"][name*="${objective.replace(/"/g, '\\"')}"]`).first();
  if (await preferred.count()) {
    await preferred.check({ force: true });
    await humanIdlePause('short');
    if (await preferred.isChecked().catch(() => false)) return true;
  }
  const knownObjective = panel.locator('input[type="checkbox"][name*="Understand web"], input[type="checkbox"][name*="Other business"]').first();
  if (await knownObjective.count()) {
    await knownObjective.check({ force: true });
    await humanIdlePause('short');
    if (await knownObjective.isChecked().catch(() => false)) return true;
  }
  return clickAnyLocator(page, [
    panel.locator('slat').filter({ hasText: /Understand web|Other business objectives|View user engagement/i }),
    panel.locator('mat-checkbox').filter({ hasText: /Understand web|Other business objectives|View user engagement/i }),
  ]).catch(() => false);
}

async function clickGoogleAnalyticsCreateButton(page) {
  const panel = activeStepPanel(page);
  for (let i = 0; i < 30; i++) {
    if (await clickAnyLocator(page, [
      panel.locator('button[aria-label="Create an account with a property"], button.create-button'),
      panel.getByRole('button', { name: /^Create$/i }),
      panel.locator('button').filter({ hasText: /^Create$/i }),
    ]).catch(() => false)) return;
    await humanIdlePause('short');
  }
  throw new Error('GA objectives Create button was not enabled');
}

export {
  selectedGaStep,
  waitForGaStep,
  waitForGaStepOrText,
  enabledButtonLocator,
  dismissGoogleAnalyticsOverlays,
  clickGaNext,
  selectVisibleChoice,
  setOptionalDropdown,
  setGoogleAnalyticsIndustry,
  setGoogleAnalyticsBusinessSize,
  setGoogleAnalyticsObjective,
  clickGoogleAnalyticsCreateButton,
};
