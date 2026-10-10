// Inspect the existing browser page without closing the page/context.
// Do not call WSession.close() here; for CDP attach that closes the user's page.

import { chromium } from 'playwright';

const endpoint = (await import('#ncbr-settings')).cdpEndpoint();
const authUrl = (await import('#ncbr-settings')).projectPermissionsUrl();

const browser = await chromium.connectOverCDP(endpoint);
const context = browser.contexts()[0];
const page = context?.pages()[0];

if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2));
  process.exit(1);
}

const result = await page.evaluate(async (authUrl) => {
  async function tryFetch(url) {
    try {
      const res = await fetch(url, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      return { url, status: res.status, text: await res.text() };
    } catch (error) {
      return { url, error: String(error?.message || error) };
    }
  }
  const inputs = Array.from(
    document.querySelectorAll('input,textarea,select'),
  ).map((el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type'),
    name: el.getAttribute('name'),
    id: el.id || null,
    autocomplete: el.getAttribute('autocomplete'),
    valueLength: 'value' in el ? String(el.value || '').length : null,
    placeholder: el.getAttribute('placeholder'),
    ariaLabel: el.getAttribute('aria-label'),
  }));
  return {
    href: location.href,
    title: document.title,
    bodyText: document.body?.innerText || '',
    inputs,
    auth: await tryFetch(authUrl),
  };
}, authUrl);

console.log(JSON.stringify(result, null, 2));
process.exit(0);
