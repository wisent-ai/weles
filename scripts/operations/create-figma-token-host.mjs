#!/usr/bin/env node
import { WSession } from '../../dist/session/wsession.js';

process.env.WELES_SECURE_CREDENTIAL_TASK = '1';
process.env.WELES_NO_INSTRUMENT = '1';
process.env.WELES_DISABLE_RECORDING = '1';
process.env.WELES_PAGE_DIAGNOSTICS = '0';

const session = await WSession.start({
  label: 'figma_token_creation',
  targetHost: 'www.figma.com',
  headless: true,
  browser: 'chromium',
  userDataDir: process.env.WELES_USER_DATA_DIR,
});
try {
  await session.goto('https://www.figma.com/files');
  const accountButton = session.page.getByRole('button', { name: /Account dropdown/i }).first();
  await accountButton.click();
  await session.page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await session.page.getByRole('tab', { name: /Security/i }).click();
  await session.page.getByRole('button', { name: /Generate new token/i }).click();
  const report = await session.page.evaluate(() => {
    const relevant = /token|scope|name|expiration|generate|file|project|team|library/i;
    return {
      buttons: Array.from(document.querySelectorAll('button,[role="button"]'))
        .map((element) => (element.getAttribute('aria-label') || element.textContent || '').trim())
        .filter((value) => value && relevant.test(value)).slice(-30),
      dialogControls: Array.from(document.querySelectorAll('[role="dialog"]:not([hidden]) *'))
        .filter((element) => {
          const role = element.getAttribute('role') || '';
          const tag = element.tagName.toLowerCase();
          return tag === 'input' || tag === 'button' || role === 'checkbox' || role === 'switch';
        })
        .map((element, index) => ({
          index,
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role') || '',
          type: element.getAttribute('type') || '',
          value: element.getAttribute('value') || '',
          ariaLabel: element.getAttribute('aria-label') || '',
          ariaChecked: element.getAttribute('aria-checked') || '',
          disabled: Boolean(element.disabled),
          ownText: (element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 160),
          labelText: (element.closest('label')?.textContent || '').trim().slice(0, 160),
        })),
      scopeLabels: Array.from(document.querySelectorAll('[role="dialog"]:not([hidden])'))
        .flatMap((dialog) => (dialog.innerText || '').split('\n'))
        .map((line) => line.trim()).filter((line) => /:read|scope|generate token|token name/i.test(line)),
    };
  });
  console.log(JSON.stringify(report));
} finally {
  await session.ctx.close().catch(() => {});
}
