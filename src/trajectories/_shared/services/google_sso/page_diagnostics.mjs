// What the Google page in front of the driver actually says: its own text, the
// controls it offers, and — when the run asks for them — a screenshot beside the
// log line.
//
// Reading a page while it navigates is not the same fact as a page with nothing
// on it, so that read has its own named answer and every caller branches on it
// instead of matching patterns against an empty string.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const PAGE_TEXT_UNREADABLE = 'weles:google-page-text-unreadable';

// The document that was there a moment ago is gone mid-read during a redirect,
// which in a poll loop means "look again", never "the page was blank".
export async function readGooglePageText(page) {
  try {
    return await page.evaluate(() => document.body?.innerText || '');
  } catch (error) {
    if (/destroyed|navigation|Target closed|crashed|detached|Session closed/i.test(error.message)) {
      return PAGE_TEXT_UNREADABLE;
    }
    throw error;
  }
}

export async function logGooglePageDiag(page, label) {
  const diag = await page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 1200);
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .map((el) => ({
        text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('disabled') !== null),
      }))
      .filter((button) => button.text)
      .slice(0, 20);
    // An attribute the element does not carry is reported as absent, because a
    // field with no declared type and a field declaring an empty type are two
    // different pages to read this diagnostic against.
    const inputs = Array.from(document.querySelectorAll('input'))
      .map((el) => ({
        type: el.getAttribute('type'),
        name: el.getAttribute('name'),
        autocomplete: el.getAttribute('autocomplete'),
        visible: Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
        valueLength: String(el.value || '').length,
      }))
      .slice(0, 20);
    return { url: location.href, title: document.title, text, buttons, inputs };
  }).catch((e) => ({ error: e.message }));
  console.log(`[google_sso] ${label} diag=${JSON.stringify(diag).slice(0, 3000)}`);

  if (process.env.GOOGLE_SSO_SCREENSHOTS === '1' && process.env.GOOGLE_SSO_NO_SCREENSHOTS !== '1') {
    const dir = process.env.GOOGLE_SSO_DIAG_DIR || '.work/google-sso-diag';
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${label.replace(/[^a-z0-9_-]/gi, '_')}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`[google_sso] ${label} screenshot=${file}`);
  }
}

export async function collectGoogleAuthMethods(page) {
  return await page.evaluate(() => {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('li, div[role="button"], div[role="option"], button, a, [data-challengetype]'))
      .map((el) => ({
        tag: (el.tagName || '').toLowerCase(),
        role: el.getAttribute('role'),
        challengeType: el.getAttribute('data-challengetype'),
        text: norm(el.innerText || el.textContent || '').slice(0, 300),
        aria: el.getAttribute('aria-label'),
      }))
      .filter((item) => /try another way|passkey|authenticator|backup code|verification code|phone|text|call|security key|gmail|prompt|password/i
        .test([item.text, item.aria, item.challengeType].filter((part) => part !== null).join(' ')))
      .slice(0, 80);
  });
}
