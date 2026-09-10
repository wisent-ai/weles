// The probe's browser page: the stable persona, page diagnostics, clicking by text, the
// authenticated-session requirement and the keep-open tail.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generatePersona } from '../../../../../dist/browser/persona.js';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { CLOSE_AFTER_PROBE, DIAG_DIR, KEEP_OPEN_AFTER_LOGIN_MS, USER_DATA_DIR } from './settings.mjs';

export function stableProfilePersona() {
  const p = join(USER_DATA_DIR, 'persona.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const persona = generatePersona({ os: 'macos', browser: 'chromium' });
  writeFileSync(p, JSON.stringify(persona, null, 2));
  return persona;
}

export async function pageDiag(page, label) {
  const frameStates = await Promise.all(page.frames().map(async (frame) => {
    return await frame.evaluate(() => {
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 5000);
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'))
        .map((b) => (b.innerText || b.textContent || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 80);
      const inputs = Array.from(document.querySelectorAll('input, textarea'))
        .map((el) => ({
          tag: el.tagName,
          type: el.getAttribute('type') || '',
          name: el.getAttribute('name') || '',
          label: el.getAttribute('aria-label') || el.getAttribute('placeholder') || '',
          visible: Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
        }))
        .slice(0, 80);
      return { url: location.href, title: document.title, text, buttons, inputs };
    }).catch((e) => ({ error: e.message, url: frame.url?.() ?? '' }));
  }));
  const data = await page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 5000);
    const links = Array.from(document.querySelectorAll('a'))
      .map((a) => ({ text: (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim(), href: a.href }))
      .filter((a) => a.text || a.href)
      .slice(0, 80);
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .map((b) => (b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 80);
    const inputs = Array.from(document.querySelectorAll('input, textarea'))
      .map((el) => ({
        tag: el.tagName,
        type: el.getAttribute('type') || '',
        name: el.getAttribute('name') || '',
        label: el.getAttribute('aria-label') || el.getAttribute('placeholder') || '',
        visible: Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
      }))
      .slice(0, 80);
    return { url: location.href, title: document.title, text, links, buttons, inputs };
  }).catch((e) => ({ error: e.message, url: page.url?.() ?? '' }));
  data.frames = frameStates;
  const outPath = join(DIAG_DIR, `${label}.json`);
  writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`[apple-ads-api-setup] ${label} json=${outPath}`);
  console.log(JSON.stringify({
    url: data.url,
    title: data.title,
    buttons: data.buttons?.slice?.(0, 20),
    inputLabels: data.inputs?.filter?.((i) => i.visible).slice(0, 20),
    frames: data.frames?.map?.((frame) => ({
      url: frame.url,
      title: frame.title,
      buttons: frame.buttons?.slice?.(0, 10),
      inputLabels: frame.inputs?.filter?.((i) => i.visible).slice(0, 10),
      text: frame.text?.slice?.(0, 500),
    })).slice?.(0, 5),
    text: data.text?.slice?.(0, 1200),
  }, null, 2));
  return data;
}

export async function clickText(page, pattern, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const loc = page.getByText(pattern).filter({ visible: true }).first();
    if (await loc.isVisible().catch(() => false)) {
      await humanClickLocator(page, loc);
      console.log(`[apple-ads-api-setup] clicked ${label}`);
      await humanIdlePause('deliberate');
      return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}
export async function keepOpen(session, loggedIn) {
  if (!loggedIn || CLOSE_AFTER_PROBE) {
    await session.close().catch(() => {});
    return;
  }

  if (KEEP_OPEN_AFTER_LOGIN_MS > 0) {
    console.log(`[apple-ads-api-setup] logged in; keeping browser open for ${KEEP_OPEN_AFTER_LOGIN_MS}ms`);
    await session.wait(Math.ceil(KEEP_OPEN_AFTER_LOGIN_MS / 1000)).catch(() => {});
    return;
  }

  console.log('[apple-ads-api-setup] logged in; keeping browser open; set APPLE_ADS_CLOSE_AFTER_PROBE=1 to close automatically');
  await new Promise(() => {});
}

export async function requireAuthenticatedSession(s) {
  const url = s.page.url?.() ?? '';
  if (url === 'about:blank') return false;

  const loginUrl = /idmsa\.apple\.com|appleid\.apple\.com|signin|login/i.test(url);
  const authIframe = await s.page.locator('iframe[src*="idmsa.apple.com"], iframe[src*="appleid.apple.com"]').count() > 0;
  let authPrompt = false;
  for (const frame of s.page.frames()) {
    authPrompt ||= await frame.locator([
      '#account_name_text_field',
      '#password_text_field',
      'input[type="password"]',
      'input[aria-label*="digit"]',
      'input[aria-label*="Digit"]',
      'input[type="tel"][maxlength="1"]',
    ].join(', ')).first().isVisible().catch(() => false);
    authPrompt ||= await frame.getByText(/Two-Factor Authentication|verification code sent to your Apple devices/i).first().isVisible().catch(() => false);
    if (authPrompt) break;
  }
  if (loginUrl || authIframe || authPrompt) {
    console.log('FAIL_CLOSED: Apple login/password/2FA is required; this probe will not authenticate. An explicitly authorized apple_login is the only permitted login path.');
    await pageDiag(s.page, 'apple_login_required');
    return false;
  }
  return true;
}
