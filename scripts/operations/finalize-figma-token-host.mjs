#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { WSession } from '../../dist/session/wsession.js';

process.env.WELES_SECURE_CREDENTIAL_TASK = '1';
process.env.WELES_NO_INSTRUMENT = '1';
process.env.WELES_DISABLE_RECORDING = '1';
process.env.WELES_PAGE_DIAGNOSTICS = '0';
const accountEmail = process.env.FIGMA_ACCOUNT_EMAIL?.trim().toLowerCase();
if (!accountEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(accountEmail)) {
  throw new Error('FIGMA_ACCOUNT_EMAIL must be one exact account email');
}
const requestId = process.env.WELES_CREDENTIAL_REQUEST_ID?.trim()
  || randomBytes(32).toString('hex');
if (!/^[a-f0-9]{64}$/i.test(requestId)) {
  throw new Error('WELES_CREDENTIAL_REQUEST_ID must be one exact credential operation id');
}
process.env.WELES_CREDENTIAL_CONSTRAINTS = JSON.stringify({
  secret: 'figma.personal_access_token',
  operation: 'acquire',
  store_secret_target: 'skarbiec',
  vault_item_id: 'weles-figma-personal-access-token',
  vault_field: 'api_key',
  secret_source_origin: 'https://www.figma.com',
  account_email: accountEmail,
  request_id: requestId,
});

const session = await WSession.start({
  label: 'figma_token_creation',
  targetHost: 'www.figma.com',
  headless: true,
  browser: 'chromium',
  userDataDir: process.env.WELES_USER_DATA_DIR,
});
try {
  await session.goto('https://www.figma.com/files');
  await session.page.getByRole('button', { name: /Account dropdown/i }).first().click();
  await session.page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await session.page.getByRole('tab', { name: /Security/i }).click();

  const tokenName = `Wisent design assets ${new Date().toISOString().slice(0, 10)}`;
  for (let cleanupAttempt = 0; cleanupAttempt < 32; cleanupAttempt += 1) {
    const revokeButtons = session.page.getByRole('button', { name: /^Revoke access$/i });
    const count = await revokeButtons.count();
    let staleButton = null;
    for (let index = 0; index < count; index += 1) {
      const button = revokeButtons.nth(index);
      const stale = await button.evaluate((element, expectedName) => {
        let current = element.parentElement;
        while (current && current !== document.body) {
          const text = (current.textContent || '').replace(/\s+/g, ' ').trim();
          if (text.includes(expectedName) && text.includes('Never used') && text.length <= 600) return true;
          current = current.parentElement;
        }
        return false;
      }, tokenName).catch(() => false);
      if (stale) {
        staleButton = button;
        break;
      }
    }
    if (!staleButton) break;
    await staleButton.click({ timeout: 5000 }).catch(() => {});
    const confirmation = session.page.getByRole('dialog').last()
      .getByRole('button', { name: /revoke/i }).last();
    if (await confirmation.isVisible().catch(() => false)) await confirmation.click();
    await session.page.waitForTimeout(250);
    const remaining = await session.page.getByRole('button', { name: /^Revoke access$/i }).count();
    if (remaining >= count) throw new Error('Figma did not revoke the stale Wisent token');
  }

  await session.ctx.grantPermissions(
    ['clipboard-read', 'clipboard-write'],
    { origin: 'https://www.figma.com' },
  );
  await session.page.evaluate(() => navigator.clipboard.writeText(''));
  await session.page.getByRole('button', { name: /Generate new token/i }).click();

  const dialog = session.page.getByRole('dialog').last();
  const inputs = dialog.locator('input');
  await inputs.first().fill(tokenName);
  const scopeControls = dialog.locator('[role="checkbox"], [role="switch"], input[type="checkbox"]');
  const scopeCount = await scopeControls.count();
  for (let index = 0; index < scopeCount; index += 1) {
    const control = scopeControls.nth(index);
    const checked = await control.getAttribute('aria-checked') === 'true'
      || await control.isChecked().catch(() => false);
    if (!checked) await control.click();
  }

  let resolveResponseToken;
  const responseToken = new Promise((resolve) => {
    resolveResponseToken = resolve;
  });
  const findToken = (value, key = '') => {
    if (typeof value === 'string') {
      if (/^figd_[A-Za-z0-9_-]{20,}$/.test(value)) return value;
      if (/token|secret|key/i.test(key)
          && value.length >= 20 && value.length <= 512
          && /[a-z]/i.test(value) && /\d/.test(value)
          && !/\s/.test(value)) return value;
      return null;
    }
    if (!value || typeof value !== 'object') return null;
    for (const [childKey, child] of Object.entries(value)) {
      const token = findToken(child, childKey);
      if (token) return token;
    }
    return null;
  };
  const responseHandler = async (response) => {
    try {
      const request = response.request();
      if (request.method() !== 'POST'
          || new URL(response.url()).origin !== 'https://www.figma.com'
          || !response.ok()) return;
      const body = await response.body();
      try {
        const token = findToken(JSON.parse(body.toString('utf8')));
        if (token) resolveResponseToken(token);
      } finally {
        body.fill(0);
      }
    } catch {}
  };
  session.page.on('response', responseHandler);
  await dialog.getByRole('button', { name: /^Generate token$/i }).click();
  let value = await Promise.race([
    responseToken,
    session.page.waitForTimeout(5000).then(() => null),
  ]);
  session.page.off('response', responseHandler);
  if (!value) {
    value = await session.page.evaluate(async () => {
      const clipboard = (await navigator.clipboard.readText()).trim();
      if (clipboard.length >= 20 && /[a-z]/i.test(clipboard) && /\d/.test(clipboard)) {
        return clipboard;
      }
      const leaves = Array.from(document.querySelectorAll('*'))
        .filter((element) => element.children.length === 0)
        .map((element) => String(element.value || element.textContent || '').trim());
      return leaves.find((candidate) => /^figd_[A-Za-z0-9_-]{20,}$/.test(candidate)) || null;
    });
  }
  if (!value) throw new Error('Figma personal access token was not present in the creation response');
  await session.page.evaluate((secret) => {
    const field = document.createElement('input');
    field.id = 'weles-figma-generated-token';
    field.type = 'text';
    field.readOnly = true;
    field.value = secret;
    field.style.display = 'none';
    document.body.appendChild(field);
  }, value);
  value = null;
  const receipt = await session.storeCredential('#weles-figma-generated-token', 'api-key');
  await session.page.evaluate(async () => {
    await navigator.clipboard.writeText('');
    document.querySelector('#weles-figma-generated-token')?.remove();
  });
  console.log(JSON.stringify({ status: 'stored', receipt }));
} finally {
  await session.ctx.close().catch(() => {});
}
