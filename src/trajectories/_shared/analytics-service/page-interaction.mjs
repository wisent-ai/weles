import { humanFill } from '../../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function safeGoto(s, url) {
  try {
    await s.goto(url);
  } catch (e) {
    const message = e.message ?? '';
    if (/ERR_ABORTED|interrupted by another navigation/i.test(message)) {
      try {
        await humanIdlePause('short');
      } catch (pauseError) {
        throw new Error(`navigation to ${url} was interrupted: ${message}; and the settle pause after the interruption failed: ${pauseError.message}`, { cause: e });
      }
    }
    const current = s.page.url();
    const target = String(url).replace(/\/$/, '');
    if (/ERR_ABORTED|interrupted by another navigation/i.test(message) && current.replace(/\/$/, '').startsWith(target)) return;
    if (/ERR_ABORTED|interrupted by another navigation/i.test(message)) {
      const currentUrl = new URL(current);
      const targetUrl = new URL(url);
      if (targetUrl.hostname === 'cloud.umami.is' && currentUrl.hostname === targetUrl.hostname && !/login|signin/i.test(current)) return;
    }
    throw e;
  }
}

async function bodyText(page) {
  try {
    return await page.evaluate(() => document.body?.innerText || '');
  } catch (error) {
    throw new Error(`page body text could not be read from ${page.url()}: ${error.message}`, { cause: error });
  }
}

async function waitRendered(page, minLength = 80) {
  for (let i = 0; i < 30; i++) {
    const text = await bodyText(page);
    if (text.length >= minLength) return text;
    await humanIdlePause('short');
  }
  return bodyText(page);
}

async function clickFirst(page, names) {
  for (const name of names) {
    const loc = page.getByRole('button', { name }).or(page.getByRole('link', { name })).or(page.getByText(name)).filter({ visible: true }).first();
    if (await loc.isVisible().catch(() => false)) {
      await humanClickLocator(page, loc, { timeoutMs: 10000 });
      await humanIdlePause('deliberate');
      return true;
    }
  }
  return false;
}

async function clickCardLike(page, name) {
  const loc = page.locator('a, button, tr, mat-row, [role="row"], [role="button"], [role="link"], mat-card, .card, .admin-card, .admin-settings-card')
    .filter({ hasText: name })
    .filter({ visible: true })
    .first();
  if (await loc.isVisible().catch(() => false)) {
    await humanClickLocator(page, loc, { timeoutMs: 10000 });
    await humanIdlePause('deliberate');
    return true;
  }
  return false;
}

async function clickLocator(page, loc, timeoutMs = 10000) {
  if (!await loc.isVisible().catch(() => false)) return false;
  try {
    await humanClickLocator(page, loc, { timeoutMs });
  } catch {
    try {
      await humanClickLocator(page, loc);
    } catch {
      return false;
    }
  }
  await humanIdlePause('deliberate');
  return true;
}

async function clickDirectLocator(page, loc) {
  const target = loc.filter({ visible: true }).first();
  if (!await target.isVisible().catch(() => false)) return false;
  const disabled = await target.evaluate((node) => (
    node.hasAttribute('disabled')
    || node.getAttribute('aria-disabled') === 'true'
    || node.classList.contains('mat-mdc-button-disabled')
    || node.classList.contains('mat-button-disabled')
  )).catch(() => false);
  if (disabled) return false;
  await target.scrollIntoViewIfNeeded();
  await humanClickLocator(page, target);
  await humanIdlePause('deliberate');
  return true;
}

async function clickAnyLocator(page, locators, description = '') {
  for (const loc of locators) {
    if (await clickDirectLocator(page, loc).catch(() => false)) return true;
  }
  if (description) throw new Error(`${description} was not clickable`);
  return false;
}

async function clickDomElement(page, selectors, textPattern = null) {
  const pattern = textPattern ? { source: textPattern.source, flags: textPattern.flags } : null;
  let target = page.locator(selectors.join(',')).filter({ visible: true });
  if (textPattern) target = target.filter({ hasText: textPattern });
  target = target.first();
  const clicked = await target.isVisible().catch(() => false)
    && !await target.isDisabled().catch(() => true)
    && await humanClickLocator(page, target).then(() => true).catch(() => false);
  if (clicked) await humanIdlePause('deliberate');
  return clicked;
}

async function fillDomInput(page, selectors, value) {
  if (!value) return false;
  const filled = await page.evaluate(({ selectors: selectorList, value: inputValue }) => {
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && box.width > 0
        && box.height > 0
        && !node.hasAttribute('disabled')
        && node.getAttribute('aria-disabled') !== 'true';
    };
    const field = selectorList
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .find((node) => visible(node));
    if (!field) return false;
    field.scrollIntoView({ block: 'center', inline: 'center' });
    field.focus();
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor?.set) descriptor.set.call(field, inputValue);
    else field.value = inputValue;
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: inputValue }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.blur();
    return true;
  }, { selectors, value }).catch(() => false);
  if (filled) await humanIdlePause('short');
  return filled;
}

async function fillAny(page, value, labelPatterns) {
  if (!value) return false;
  for (const pattern of labelPatterns) {
    const byLabel = page.getByLabel(pattern).filter({ visible: true }).first();
    if (await byLabel.isVisible().catch(() => false)) {
      await humanFill(page, byLabel, value);
      return true;
    }
    const byPlaceholder = page.getByPlaceholder(pattern).filter({ visible: true }).first();
    if (await byPlaceholder.isVisible().catch(() => false)) {
      await humanFill(page, byPlaceholder, value);
      return true;
    }
  }
  const inputBox = page.locator('input:not([type="hidden"]), textarea').filter({ visible: true }).first();
  if (await inputBox.isVisible().catch(() => false)) {
    await humanFill(page, inputBox, value);
    return true;
  }
  return false;
}

async function fillWithin(scope, page, value, labelPatterns) {
  if (!value) return false;
  for (const pattern of labelPatterns) {
    const byLabel = scope.getByLabel(pattern).filter({ visible: true }).first();
    if (await byLabel.isVisible().catch(() => false)) {
      await humanFill(page, byLabel, value);
      return true;
    }
    const byPlaceholder = scope.getByPlaceholder(pattern).filter({ visible: true }).first();
    if (await byPlaceholder.isVisible().catch(() => false)) {
      await humanFill(page, byPlaceholder, value);
      return true;
    }
  }
  return false;
}

async function fillWithinOrNth(scope, page, value, labelPatterns, index) {
  if (await fillWithin(scope, page, value, labelPatterns)) return true;
  const field = scope.locator('input:not([type="hidden"]), textarea').filter({ visible: true }).nth(index);
  if (await field.isVisible().catch(() => false)) {
    await humanFill(page, field, value);
    return true;
  }
  return false;
}

async function clickRequired(page, names, description) {
  if (await clickFirst(page, names)) return;
  throw new Error(`${description} was not clickable`);
}

function activeStepPanel(page) {
  return page
    .locator('div[role="tabpanel"]:not([inert]):not([aria-hidden="true"])')
    .filter({ visible: true })
    .first();
}

async function visibleFormScope(page) {
  const panel = activeStepPanel(page);
  if (await panel.isVisible().catch(() => false)) return panel;
  return page
    .getByRole('dialog')
    .or(page.locator('form, main, ga-admin-root, [role="main"], body'))
    .filter({ visible: true })
    .first();
}

export {
  escapeRegExp,
  safeGoto,
  bodyText,
  waitRendered,
  clickFirst,
  clickCardLike,
  clickLocator,
  clickDirectLocator,
  clickAnyLocator,
  clickDomElement,
  fillDomInput,
  fillAny,
  fillWithin,
  fillWithinOrNth,
  clickRequired,
  activeStepPanel,
  visibleFormScope,
};
