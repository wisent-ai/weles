// JuicySMS dashboard order-history inspection via Google SSO.
// Same login flow balance.mjs uses (the auto-account is Google-linked,
// not password-secured). After SSO, capture the selected account pages
// and follow the order history's offered pagination links.
import { WSession } from '../../../dist/session/wsession.js';
import {
  googleSso,
  getGoogleSsoCreds,
} from '../_shared/services/google_sso.mjs';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import {
  pageSettled,
  popupOrNavigation,
  urlMatching,
} from '../_shared/page/settled.mjs';
import { openJuicyPage } from './page.mjs';
import { runOutputPath } from '#run-output';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOGIN_URL = 'https://juicysms.com/login';
// The OAuth round trip lands back on a juicysms.com route other than /login.
const LANDED = /^https:\/\/(www\.)?juicysms\.com\/(?!login)/;
const OUT_DIR = runOutputPath('juicysms_dashboard');

const login = await getGoogleSsoCreds();
if (!login) {
  console.log('FAIL: no Google SSO credentials in DB');
  process.exit(1);
}
console.log(`[dash] Using Google SSO: ${login.email}`);

const s = await WSession.start({
  label: 'juicysms_dashboard',
  browser: 'chromium',
});
try {
  await openJuicyPage(s, LOGIN_URL);
  const googleButton = s.page
    .locator(
      'a:has-text("LOGIN WITH GOOGLE"), button:has-text("LOGIN WITH GOOGLE"), a:has-text("Login with Google"), button:has-text("Login with Google")',
    )
    .and(s.page.locator(':not(:disabled):not([aria-disabled="true"])'))
    .filter({ visible: true })
    .first();
  await googleButton.waitFor({ state: 'visible' });
  const popup = await popupOrNavigation(s.page, /accounts\.google\.com/, () =>
    humanClickLocator(s.page, googleButton),
  );

  const ok = await googleSso(s, login, {
    originHost: 'juicysms.com',
    page: popup ?? undefined,
  });
  if (!ok) throw new Error('google_sso_did_not_complete');

  // Wait until URL settles on juicysms.com (the OAuth roundtrip lands us
  // back on a juicysms route eventually). Earlier check `!/login` exited
  // while still on accounts.google.com, then the next goto raced the
  // OAuth redirect and threw ERR_ABORTED.
  await urlMatching(s.page, LANDED);
  console.log(`[dash] post-SSO URL=${s.page.url()}`);
  await pageSettled(s.page);

  mkdirSync(OUT_DIR, { recursive: true });

  // Capture the authenticated application routes, including pages exposed by
  // its user menu rather than by the public marketing navigation.
  async function dumpPath(path) {
    await openJuicyPage(s, `https://juicysms.com${path}`);
    const slug =
      path === '/'
        ? 'home'
        : path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const html = await s.page.content();
    writeFileSync(join(OUT_DIR, `${slug}.html`), html);
    console.log(
      `[dash] ${path} rendered ${html.length}b at url=${s.page.url()}`,
    );
  }

  await dumpPath('/');
  await dumpPath('/myaccount');
  await dumpPath('/addfunds');
  await dumpPath('/hire-panel');
  await dumpPath('/webhooks');
  // MyOrders renders orders.data keyed by id and follows orders.links URLs.
  // Inspect those same links instead of assuming a historical page count.
  await dumpPath('/myorders');
  const history = await s.page.evaluate(async () => {
    // allow-raw-playwright: read-only fetch loop, no synthetic events
    const entities = { quot: '"', amp: '&', '#039': "'", lt: '<', gt: '>' };
    const decode = (text) =>
      text.replace(/&(quot|amp|#039|lt|gt);/g, (_, key) => entities[key]);
    const orders = [];
    const pages = [];
    const ids = new Set();
    const origin = location.origin;
    let address = new URL('/myorders?page=1', origin);
    let pageNumber = 1;
    const fail = (code, details = {}) => {
      throw new Error(
        `${code}: ${JSON.stringify({ page: pageNumber, url: address.href, ...details })}`,
      );
    };
    for (;;) {
      let response;
      try {
        response = await fetch(address.href, {
          credentials: 'include',
          redirect: 'manual',
        });
      } catch (error) {
        fail('JUICYSMS_ORDERS_FETCH_FAILED', { cause: error.message });
      }
      if (response.type === 'opaqueredirect')
        fail('JUICYSMS_ORDERS_REDIRECTED');
      if (!response.ok)
        fail('JUICYSMS_ORDERS_HTTP_ERROR', {
          status: response.status,
          responseUrl: response.url,
        });
      let html;
      try {
        html = await response.text();
      } catch (error) {
        fail('JUICYSMS_ORDERS_BODY_FAILED', {
          status: response.status,
          cause: error.message,
        });
      }
      const match = html.match(/data-page="([^"]+)"/);
      if (!match)
        fail('JUICYSMS_ORDERS_STATE_MISSING', { status: response.status });
      let data;
      try {
        data = JSON.parse(decode(match[1]));
      } catch (error) {
        fail('JUICYSMS_ORDERS_STATE_INVALID', { cause: error.message });
      }
      const collection = data?.props?.orders;
      if (
        !Array.isArray(collection?.data) ||
        !Array.isArray(collection?.links)
      ) {
        fail('JUICYSMS_ORDERS_SHAPE_INVALID', {
          component: data?.component ?? null,
        });
      }
      for (const order of collection.data) {
        const id = order?.id;
        if (
          !(typeof id === 'string' && id.length > 0) &&
          !(Number.isSafeInteger(id) && id > 0)
        ) {
          fail('JUICYSMS_ORDER_ID_UNAVAILABLE');
        }
        const key = String(id);
        if (ids.has(key)) fail('JUICYSMS_ORDER_REPEATED', { orderId: key });
        ids.add(key);
        orders.push(order);
      }
      let next = null;
      let hasLaterPage = false;
      for (const link of collection.links) {
        if (!link || !Object.hasOwn(link, 'url'))
          fail('JUICYSMS_ORDERS_LINK_INVALID');
        if (link.url === null) continue;
        if (typeof link.url !== 'string' || !link.url)
          fail('JUICYSMS_ORDERS_LINK_INVALID');
        let target;
        try {
          target = new URL(link.url, address);
        } catch (error) {
          fail('JUICYSMS_ORDERS_LINK_INVALID', {
            target: link.url,
            cause: error.message,
          });
        }
        if (
          target.origin !== origin ||
          target.pathname !== '/myorders' ||
          target.username ||
          target.password ||
          target.hash
        ) {
          fail('JUICYSMS_ORDERS_LINK_OUTSIDE_HISTORY', { target: target.href });
        }
        const rawPage = target.searchParams.get('page');
        const number = rawPage === null ? 1 : Number(rawPage);
        if (
          (rawPage !== null && !/^[1-9]\d*$/.test(rawPage)) ||
          !Number.isSafeInteger(number) ||
          number < 1
        ) {
          fail('JUICYSMS_ORDERS_PAGE_INVALID', { target: target.href });
        }
        if (number > pageNumber) hasLaterPage = true;
        if (number === pageNumber + 1 && !next) next = target;
      }
      pages.push({
        page: pageNumber,
        url: response.url,
        status: response.status,
        count: collection.data.length,
      });
      if (!next) {
        if (hasLaterPage) fail('JUICYSMS_ORDERS_PAGINATION_GAP');
        break;
      }
      if (!collection.data.length)
        fail('JUICYSMS_ORDERS_EMPTY_BEFORE_NEXT_PAGE');
      address = next;
      pageNumber += 1;
    }
    return { orders, pages };
  });
  writeFileSync(
    join(OUT_DIR, 'all_orders.json'),
    JSON.stringify(history.orders, null, 2),
  );
  writeFileSync(
    join(OUT_DIR, 'orders_pages.json'),
    JSON.stringify(history.pages, null, 2),
  );
  console.log(
    `[dash] aggregated ${history.orders.length} orders across ${history.pages.length} provider-linked page(s) into ${join(OUT_DIR, 'all_orders.json')}`,
  );

  console.log('[dash] PASS');
} catch (e) {
  console.error('[dash] FAIL:', e);
  process.exitCode = 1;
} finally {
  await s.close();
}
