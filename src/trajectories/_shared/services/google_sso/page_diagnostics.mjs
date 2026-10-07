// What the Google page in front of the driver actually says: its own text, the
// controls it offers, and — when the run asks for them — a screenshot beside the
// log line.
//
// Reading a page while it navigates is not the same fact as a page with nothing
// on it, so that read has its own named answer and every caller branches on it
// instead of matching patterns against an empty string.
import { runOutputPath } from '#run-output';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const PAGE_TEXT_UNREADABLE = 'weles:google-page-text-unreadable';
export const DOCUMENT_REPLACED = Symbol('weles:google-document-replaced');

// Run one read of `page` and answer DOCUMENT_REPLACED when it failed because
// the document it read went away: the main frame navigated, or the page
// closed or crashed, while the read was pending. Those are what the page
// itself reported, not words in Playwright's error; any other failure is
// thrown. Events can reach this process just after the rejection, so the
// check is made again on the next turn of the event loop before throwing.
export async function readAcrossNavigation(page, read) {
  let replaced = false;
  const onNavigated = (frame) => { if (frame === page.mainFrame()) replaced = true; };
  const onGone = () => { replaced = true; };
  page.on('framenavigated', onNavigated);
  page.on('close', onGone);
  page.on('crash', onGone);
  try {
    return await read();
  } catch (error) {
    if (!replaced && !page.isClosed()) await new Promise((resolve) => setImmediate(resolve));
    if (replaced || page.isClosed()) return DOCUMENT_REPLACED;
    throw error;
  } finally {
    page.off('framenavigated', onNavigated);
    page.off('close', onGone);
    page.off('crash', onGone);
  }
}

// The document that was there a moment ago is gone mid-read during a redirect,
// which in a poll loop means "look again", never "the page was blank".
export async function readGooglePageText(page) {
  const text = await readAcrossNavigation(page, () => page.evaluate(() => document.body?.innerText || ''));
  return text === DOCUMENT_REPLACED ? PAGE_TEXT_UNREADABLE : text;
}

export async function logGooglePageDiag(page, label) {
  const diag = await page.evaluate(() => {
    const text = document.body.innerText.replace(/\s+/g, ' ');
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .map((el) => ({
        text: el.innerText.replace(/\s+/g, ' ').trim(),
        disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('disabled') !== null),
      }))
      .filter((button) => button.text);
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
      }));
    return { url: location.href, title: document.title, text, buttons, inputs };
  }).catch((e) => ({ error: e.message }));
  console.log(`[google_sso] ${label} diag=${JSON.stringify(diag)}`);

  if (process.env.GOOGLE_SSO_SCREENSHOTS === '1' && process.env.GOOGLE_SSO_NO_SCREENSHOTS !== '1') {
    const dir = process.env.GOOGLE_SSO_DIAG_DIR || runOutputPath('google-sso-diag');
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
        text: norm(el.innerText),
        aria: el.getAttribute('aria-label'),
      }))
      .filter((item) => /try another way|passkey|authenticator|backup code|verification code|phone|text|call|security key|gmail|prompt|password/i
        .test([item.text, item.aria, item.challengeType].filter((part) => part !== null).join(' ')));
  });
}
