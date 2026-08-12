import { WSession } from '../../../dist/session/wsession.js';
import { getGoogleSsoCreds, googleSso } from '../_shared/services/google_sso.mjs';
import { humanClickLocator } from '../../../dist/human/mouse.js';

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const tunnelId = process.env.CLOUDFLARE_TUNNEL_ID || '';
const hostname = process.env.CLOUDFLARE_HOSTNAME || '';
const originUrl = process.env.CLOUDFLARE_ORIGIN_URL || '';
const accountEmail = (process.env.CLOUDFLARE_ACCOUNT_EMAIL || '').trim().toLowerCase();

if (!/^[0-9a-f]{32}$/.test(accountId)) throw new Error('CLOUDFLARE_ACCOUNT_ID is invalid');
if (!/^[0-9a-f-]{36}$/.test(tunnelId)) throw new Error('CLOUDFLARE_TUNNEL_ID is invalid');
if (!/^[a-z0-9-]+\.[a-z0-9.-]+$/.test(hostname)) throw new Error('CLOUDFLARE_HOSTNAME is invalid');
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(originUrl)) throw new Error('CLOUDFLARE_ORIGIN_URL must be a loopback HTTP origin');
if (!accountEmail) throw new Error('CLOUDFLARE_ACCOUNT_EMAIL is required');

const routeUrl = `https://dash.cloudflare.com/${accountId}/tunnels/${tunnelId}/routes`;
const [subdomain, ...domainParts] = hostname.split('.');
const domain = domainParts.join('.');

async function visible(locator) {
  return locator.isVisible().catch(() => false);
}

async function dismissCookieConsent(page) {
  for (const label of ['Reject All But Necessary', 'Confirm My Choices']) {
    const button = page.getByRole('button', { name: label, exact: true }).filter({ visible: true }).first();
    if (await visible(button)) {
      await button.click({ force: true });
      await page.waitForTimeout(500);
      return;
    }
  }
}

async function ensureCloudflareSession(session) {
  let page = session.page;
  if (!/^https:\/\/dash\.cloudflare\.com\/login(?:[/?#]|$)/i.test(page.url())) return page;

  const credentials = await getGoogleSsoCreds(accountEmail);
  if (!credentials) throw new Error(`Google SSO credentials are unavailable for ${accountEmail}`);
  const context = page.context();
  const googleButton = page.getByRole('button', { name: /continue with google/i })
    .or(page.getByRole('link', { name: /continue with google/i }))
    .filter({ visible: true })
    .first();
  if (!await visible(googleButton)) throw new Error('Cloudflare Google sign-in control is unavailable');

  const popupPromise = context.waitForEvent('page', { timeout: 10_000 }).catch(() => null);
  await googleButton.click({ noWaitAfter: true });
  const authPage = await popupPromise
    ?? context.pages().find((candidate) => /accounts\.google\.com/i.test(candidate.url()))
    ?? page;
  const signedIn = await googleSso(session, credentials, { page: authPage, originHost: 'dash.cloudflare.com' });
  if (!signedIn) throw new Error(`Cloudflare Google SSO failed for ${accountEmail}`);

  for (let attempt = 0; attempt < 60; attempt += 1) {
    page = context.pages().find((candidate) => (
      !candidate.isClosed?.()
      && /^https:\/\/dash\.cloudflare\.com\/(?!login(?:[/?#]|$))/i.test(candidate.url())
    ));
    if (page) {
      session.page = page;
      await page.bringToFront().catch(() => {});
      return page;
    }
    await authPage.waitForTimeout(500);
  }
  throw new Error('Cloudflare Google SSO returned without a dashboard session');
}

async function routeState(page) {
  const text = await page.locator('body').innerText().catch(() => '');
  return {
    hostname: text.includes(hostname),
    origin: text.includes(originUrl) || text.includes(originUrl.replace(/^http:\/\//, '')),
  };
}

const session = await WSession.start({
  label: 'generic_keeper_task',
  browser: 'chromium',
  proxy: 'none',
  targetHost: 'dash.cloudflare.com',
  headless: false,
});

try {
  await session.goto(routeUrl);
  let page = await ensureCloudflareSession(session);
  if (page.url() !== routeUrl) await page.goto(routeUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await dismissCookieConsent(page);
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  const initial = await routeState(page);
  if (initial.hostname && initial.origin) {
    console.log(JSON.stringify({ status: 'unchanged', hostname, origin_url: originUrl, tunnel_id: tunnelId }));
    console.log('PASS: Cloudflare tunnel route already matches');
  } else {
    if (initial.hostname) throw new Error(`existing ${hostname} route does not target ${originUrl}`);

    const addRoute = page.getByRole('button', { name: 'Add route', exact: true }).filter({ visible: true }).first();
    await addRoute.waitFor({ state: 'visible', timeout: 30_000 });
    const addResult = await session.click('Add route');
    if (addResult === 'no-target-found') throw new Error('Cloudflare Add route control is unavailable');

    const publishedApplication = page.getByRole('button', { name: 'Published application', exact: true })
      .filter({ visible: true })
      .first();
    await publishedApplication.waitFor({ state: 'visible', timeout: 10_000 });
    const publishedResult = await session.click('Published application');
    if (publishedResult === 'no-target-found') {
      const visibleText = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 2000);
      throw new Error(`Cloudflare route type chooser is unavailable: ${visibleText}`);
    }

    const hostnameInput = page.locator('input[placeholder="www"]').filter({ visible: true }).first();
    await hostnameInput.waitFor({ state: 'visible', timeout: 10_000 });
    await hostnameInput.fill(subdomain);

    const domainResult = await session.click('Select domain');
    if (domainResult === 'no-target-found') throw new Error('Cloudflare domain chooser is unavailable');
    const optionResult = await session.click(domain);
    if (optionResult === 'no-target-found') throw new Error(`Cloudflare domain ${domain} is unavailable`);

    const originInput = page.locator('input[placeholder="https://localhost:8080"]').filter({ visible: true }).first();
    await originInput.fill(originUrl);

    const submit = page.locator('button[type="submit"]').filter({ visible: true }).last();
    await submit.waitFor({ state: 'visible', timeout: 10_000 });
    await humanClickLocator(page, submit);

    let final = { hostname: false, origin: false };
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await page.waitForTimeout(500);
      final = await routeState(page);
      if (final.hostname && final.origin) break;
    }
    if (!final.hostname || !final.origin) {
      throw new Error(`Cloudflare did not confirm ${hostname} -> ${originUrl}`);
    }

    console.log(JSON.stringify({ status: 'created', hostname, origin_url: originUrl, tunnel_id: tunnelId }));
    console.log('PASS: Cloudflare tunnel route created');
  }
} finally {
  await session.close().catch(() => {});
}
