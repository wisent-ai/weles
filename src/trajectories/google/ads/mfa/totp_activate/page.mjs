// The Google account page as the activation reads and clicks it.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';
import { DIAG_DIR, redact, visibleTextSelector } from './settings.mjs';

export async function diag(page, label, secret = '') {
  const data = await page.evaluate(() => {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const controls = Array.from(document.querySelectorAll('button, [role="button"], a, [role="link"], li, div[role="option"]'))
      .map((el) => ({
        tag: (el.tagName || '').toLowerCase(),
        role: el.getAttribute('role') || '',
        text: norm(el.innerText || el.textContent || '').slice(0, 240),
        aria: el.getAttribute('aria-label') || '',
        href: el.href || '',
        disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      }))
      .filter((item) => item.text || item.aria || item.href)
      .slice(0, 160);
    const inputs = Array.from(document.querySelectorAll('input'))
      .map((el) => ({
        type: el.getAttribute('type') || '',
        name: el.getAttribute('name') || '',
        autocomplete: el.getAttribute('autocomplete') || '',
        aria: el.getAttribute('aria-label') || '',
        placeholder: el.getAttribute('placeholder') || '',
        visible: Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
        valueLength: String(el.value || '').length,
      }))
      .slice(0, 80);
    return {
      url: location.href,
      title: document.title,
      text: norm(document.body?.innerText || '').slice(0, 5000),
      controls,
      inputs,
    };
  }).catch((error) => ({ url: page.url?.() || '', error: String(error?.message || error) }));
  const redacted = JSON.parse(redact(JSON.stringify(data), secret));
  const jsonPath = join(DIAG_DIR, `${label}.json`);
  writeFileSync(jsonPath, JSON.stringify(redacted, null, 2));
  console.log(`[google-totp-activate] ${label} json=${jsonPath}`);
  console.log(JSON.stringify({
    url: redacted.url,
    title: redacted.title,
    text: redacted.text?.slice?.(0, 1400),
    controls: redacted.controls?.slice?.(0, 30),
    inputs: redacted.inputs?.filter?.((input) => input.visible).slice(0, 20),
  }, null, 2));
  return data;
}

export async function clickByText(page, pattern, label) {
  const role = page.getByRole('button', { name: pattern, exact: false })
    .or(page.getByRole('link', { name: pattern, exact: false }))
    .or(page.getByRole('option', { name: pattern, exact: false }))
    .filter({ visible: true })
    .first();
  if (await role.isVisible().catch(() => false)) {
    console.log(`[google-totp-activate] clicking ${label} via role`);
    await role.click({ force: true }).catch(() => humanClickLocator(page, role));
    await humanIdlePause('deliberate');
    return true;
  }

  const textual = page.locator(visibleTextSelector()).filter({ hasText: pattern }).filter({ visible: true }).first();
  if (await textual.isVisible().catch(() => false)) {
    console.log(`[google-totp-activate] clicking ${label} via text`);
    await textual.click({ force: true }).catch(() => humanClickLocator(page, textual));
    await humanIdlePause('deliberate');
    return true;
  }

  const fallback = page.locator('button, [role="button"], a, [role="link"], li, [role="option"]').filter({ hasText: pattern }).filter({ visible: true }).first();
  const clickedByJs = await humanClickLocator(page, fallback).then(() => true).catch(() => false);
  if (clickedByJs) {
    console.log(`[google-totp-activate] clicking ${label} via JS`);
    await humanIdlePause('deliberate');
    return true;
  }
  return false;
}

export async function currentBodyText(page) {
  return await page.evaluate(() => document.body?.innerText || '').catch(() => '');
}
