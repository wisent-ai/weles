import { humanIdlePause } from '../../../../../dist/human/mouse.js';
import { GA_BASE, defaultInput, siteHost } from '../action-catalog.mjs';
import {
  safeGoto,
  bodyText,
  waitRendered,
  clickDomElement,
  clickAnyLocator,
  clickLocator,
  clickFirst,
  fillDomInput,
  fillWithinOrNth,
  visibleFormScope,
} from '../page-interaction.mjs';
import {
  dismissGoogleAnalyticsOverlays,
  clickGaNext,
  waitForGaStep,
  waitForGaStepOrText,
  selectVisibleChoice,
  setOptionalDropdown,
  setGoogleAnalyticsIndustry,
  setGoogleAnalyticsBusinessSize,
  setGoogleAnalyticsObjective,
  clickGoogleAnalyticsCreateButton,
} from './wizard-controls.mjs';
import {
  extractGaMeasurementId,
  fillGoogleAnalyticsWebStreamStep,
  openGoogleAnalyticsCreatedStreamDetail,
} from './web-stream.mjs';

function gaRegistrationInputs() {
  const siteUrl = defaultInput('SITE_URL', 'https://www.needher.ai');
  const propertyName = defaultInput('PROPERTY_NAME', 'NeedHer AI');
  return {
    accountName: defaultInput('ACCOUNT_NAME', propertyName),
    propertyName,
    siteUrl,
    streamName: defaultInput('STREAM_NAME', `${propertyName} Web`),
    timezone: defaultInput('TIMEZONE', 'United States'),
    currency: defaultInput('CURRENCY', 'US Dollar'),
    domain: siteHost(siteUrl),
  };
}

async function openGoogleAnalyticsCreateAccount(s) {
  await safeGoto(s, GA_BASE);
  await humanIdlePause('long');
  await dismissGoogleAnalyticsOverlays(s.page);

  const currentHash = new URL(s.page.url()).hash;
  const scope = currentHash.match(/^#\/(a\d+p\d+)\b/)?.[1];
  const adminUrl = scope ? `${GA_BASE}#/${scope}/admin` : `${GA_BASE}#/admin`;
  await safeGoto(s, adminUrl);
  await humanIdlePause('long');
  await dismissGoogleAnalyticsOverlays(s.page);
  for (let i = 0; i < 40; i++) {
    if (await s.page.locator('button[data-guidedhelpid="create-entity-trigger"], .create-entity-menu-trigger').filter({ visible: true }).first().isVisible().catch(() => false)) break;
    if (/\/admin\b/i.test(s.page.url()) && /Account settings|Property settings|Data streams|Create/i.test(await bodyText(s.page))) break;
    await humanIdlePause('short');
  }

  const createButton = [
    s.page.locator('button[data-guidedhelpid="create-entity-trigger"]'),
    s.page.locator('.create-entity-menu-trigger'),
  ];
  if (!await clickDomElement(s.page, ['button[data-guidedhelpid="create-entity-trigger"]', '.create-entity-menu-trigger'], /^Create\b/i)
    && !await clickAnyLocator(s.page, createButton).catch(() => false)) {
    await safeGoto(s, adminUrl);
    await humanIdlePause('long');
    await dismissGoogleAnalyticsOverlays(s.page);
    if (!await clickDomElement(s.page, ['button[data-guidedhelpid="create-entity-trigger"]', '.create-entity-menu-trigger'], /^Create\b/i)) {
      await clickAnyLocator(s.page, createButton, 'GA Admin Create button');
    }
  }
  await humanIdlePause('deliberate');
  if (!await clickDomElement(s.page, [
    '.cdk-overlay-container [role="menuitem"]',
    '.cdk-overlay-container button',
    '.mat-mdc-menu-panel [role="menuitem"]',
    '.mat-mdc-menu-panel button',
    '[role="menuitem"]',
  ], /^(Create account|Account)$/i)) {
    await clickAnyLocator(s.page, [
      s.page.getByRole('menuitem', { name: /^Account$/i }),
      s.page.getByRole('menuitem', { name: /Create account/i }),
    ], 'GA Create Account menu item');
  }
  await waitRendered(s.page, 40);
}

async function fillGoogleAnalyticsAccountStep(s, values) {
  const scope = await visibleFormScope(s.page);
  const filled = await fillDomInput(s.page, [
    'input[debug-id="account-name-input"]',
    'ga-account-setup input:not([type="hidden"])',
  ], values.accountName);
  if (!filled && !await fillWithinOrNth(scope, s.page, values.accountName, [/account name/i, /^name$/i], 0)) {
    throw new Error('GA account-name field was not fillable');
  }
  if (!await clickDomElement(s.page, ['button[debug-id="account-next-step-button"]'], /^Next$/i)) {
    await clickGaNext(s.page, 'GA account setup next button', /Property creation/i);
    return;
  }
  await waitForGaStep(s.page, /Property creation/i, 'GA account setup next button');
}

async function fillGoogleAnalyticsPropertyStep(s, values) {
  const scope = await visibleFormScope(s.page);
  const filled = await fillDomInput(s.page, [
    'input[data-guidedhelpid="property-name-input"]',
    'input[debug-id="property-name-input"]',
    'ga-property-setup input:not([type="hidden"])',
  ], values.propertyName);
  if (!filled && !await fillWithinOrNth(scope, s.page, values.propertyName, [/property name/i, /^name$/i], 0)) {
    throw new Error('GA property-name field was not fillable');
  }
  await setOptionalDropdown(s.page, [/reporting time zone/i, /time zone/i], values.timezone).catch(() => false);
  await setOptionalDropdown(s.page, [/currency/i], values.currency).catch(() => false);
  if (!await clickDomElement(s.page, ['button[debug-id="property-next-step-button"]'], /^Next$/i)) {
    await clickGaNext(s.page, 'GA property setup next button', /Business details/i);
    return;
  }
  await waitForGaStep(s.page, /Business details/i, 'GA property setup next button');
}

async function fillGoogleAnalyticsBusinessStep(s) {
  await setGoogleAnalyticsIndustry(s.page).catch(() => false);
  if (!await setGoogleAnalyticsBusinessSize(s.page).catch(() => false)) {
    await selectVisibleChoice(s.page, [/small/i, /1 to 10/i, /medium/i]).catch(() => false);
  }
  await clickGaNext(s.page, 'GA business details next button', /Business objectives/i);
}

async function fillGoogleAnalyticsObjectivesStep(s) {
  if (!await setGoogleAnalyticsObjective(s.page).catch(() => false)) {
    await selectVisibleChoice(s.page, [/understand web/i, /other business objectives/i, /examine user behavior/i, /traffic/i]).catch(() => false);
  }
  await clickGoogleAnalyticsCreateButton(s.page);
  await waitForGaStepOrText(s.page, /Data collection/i, /terms|service agreement|data collection|platform|web stream|website url/i, 'GA business objectives create button');
}

async function acceptGoogleAnalyticsTermsIfPresent(s) {
  const text = await bodyText(s.page);
  if (!/terms|service agreement|data processing|privacy/i.test(text)) return;

  const dialog = s.page.getByRole('dialog')
    .filter({ hasText: /Terms of Service Agreement|Data Processing Terms|I Accept/i })
    .filter({ visible: true })
    .first();
  if (await dialog.isVisible().catch(() => false)) {
    const requiredBox = dialog.locator('input[type="checkbox"]').first();
    if (await requiredBox.count()) {
      await requiredBox.check({ force: true });
      await humanIdlePause('short');
    }
    const acceptButton = dialog.locator('button[debug-id="accept-button"], button').filter({ hasText: /^I Accept$/i });
    for (let i = 0; i < 30; i++) {
      if (await clickAnyLocator(s.page, [acceptButton]).catch(() => false)) {
        await waitForGaStepOrText(s.page, /Data collection/i, /data collection|platform|web stream|website url/i, 'GA terms accept button');
        return;
      }
      await humanIdlePause('short');
    }
    throw new Error('GA Terms accept button was not enabled');
  }

  const boxes = s.page.locator('mat-checkbox, input[type="checkbox"], [role="checkbox"]').filter({ visible: true });
  const count = await boxes.count();
  for (let i = 0; i < Math.min(count, 6); i++) {
    const box = boxes.nth(i);
    const checked = await box.getAttribute('aria-checked');
    if (checked !== 'true') await clickLocator(s.page, box);
  }
  await clickFirst(s.page, [/^I accept$/i, /^Accept$/i, /^Agree$/i, /^Create$/i]).catch(() => false);
  await waitRendered(s.page, 40);
}

async function googleAnalyticsRegisterSite(s) {
  const values = gaRegistrationInputs();
  await openGoogleAnalyticsCreateAccount(s);
  await fillGoogleAnalyticsAccountStep(s, values);
  await fillGoogleAnalyticsPropertyStep(s, values);
  await fillGoogleAnalyticsBusinessStep(s, values);
  await fillGoogleAnalyticsObjectivesStep(s, values);
  await acceptGoogleAnalyticsTermsIfPresent(s);
  await fillGoogleAnalyticsWebStreamStep(s, values);
  await openGoogleAnalyticsCreatedStreamDetail(s, values);

  for (let i = 0; i < 60; i++) {
    const text = await bodyText(s.page);
    const measurementId = extractGaMeasurementId(text);
    if (measurementId) {
      return { registration: { ...values, measurementId } };
    }
    await humanIdlePause('short');
  }
  const text = await bodyText(s.page);
  throw new Error(`GA registration completed no visible measurement id; final_url=${s.page.url()}; body_preview=${text.slice(0, 800).replace(/\s+/g, ' ')}`);
}

export {
  gaRegistrationInputs,
  openGoogleAnalyticsCreateAccount,
  fillGoogleAnalyticsAccountStep,
  fillGoogleAnalyticsPropertyStep,
  fillGoogleAnalyticsBusinessStep,
  fillGoogleAnalyticsObjectivesStep,
  acceptGoogleAnalyticsTermsIfPresent,
  googleAnalyticsRegisterSite,
};
