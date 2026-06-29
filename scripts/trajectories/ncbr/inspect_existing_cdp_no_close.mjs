// Inspect the existing browser page without closing the page/context.
// Do not call WSession.close() here; for CDP attach that closes the user's page.

import { chromium } from 'playwright';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';

const browser = await chromium.connectOverCDP(endpoint);
const context = browser.contexts()[0];
const page = context?.pages()[0];

if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2));
  process.exit(0);
}

const result = await page.evaluate(async () => {
  async function tryFetch(url) {
    try {
      const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
      return { status: res.status, text: (await res.text()).slice(0, 300) };
    } catch (error) {
      return { error: String(error?.message || error) };
    }
  }
  const inputs = Array.from(document.querySelectorAll('input,textarea,select')).map((el) => ({
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
    bodyText: (document.body?.innerText || '').slice(0, 1200),
    inputs,
    auth: await tryFetch('https://lsi2.ncbr.gov.pl/api/beneficiary/project/433468ab-ff8a-4bd2-9f03-7da65ba73e1f/get-user-permissions'),
  };
});

console.log(JSON.stringify(result, null, 2));
process.exit(0);
