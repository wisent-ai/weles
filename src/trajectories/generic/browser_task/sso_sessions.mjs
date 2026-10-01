import { getGoogleSsoCreds, googleSso } from '../../_shared/services/google_sso.mjs';
import { pageSettled } from '../../_shared/page/settled.mjs';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { humanFill } from '../../../../dist/human/keyboard.js';

const GOOGLE_BUTTON = /continue with google|log in with google|sign in with google/i;
const FIGMA_LOGIN = /figma\.com\/login(?:[/?#]|$)/i;

/** A wait the page cut short (navigation, closed page) is logged, not fatal. */
function noteCutShort(step) {
  return (error) => console.log(`[sso] ${step} cut short: ${String(error?.message ?? error).slice(0, 120)}`);
}

/** Click the Google control and return the Google OAuth surface: the page the
 * click opened, or this page once it has moved to accounts.google.com. */
async function clickToOAuthPage(context, page, googleButton) {
  const opened = context.waitForEvent('page');
  const inPlace = page.waitForURL(/accounts\.google\.com/i).then(() => page);
  await humanClickLocator(page, googleButton);
  return Promise.any([opened, inPlace]);
}

/** Sign the session into Supabase through Google SSO when the task acquires a Supabase token. */
export async function ensureSupabaseSession(activeSession, taskConstraints) {
  const accountEmail = typeof taskConstraints.account_email === 'string'
    ? taskConstraints.account_email.trim().toLowerCase()
    : '';
  if (taskConstraints.secret !== 'supabase.personal_access_token' || !accountEmail) return;

  const page = activeSession.page;
  await page.waitForLoadState?.('domcontentloaded').catch(noteCutShort('supabase load'));
  if (!/sign-in|accounts\.google\.com/i.test(page.url())) return;
  const credentials = await getGoogleSsoCreds(accountEmail);
  if (!credentials) throw new Error(`Google SSO credentials are unavailable for ${accountEmail}`);

  let authPage = page;
  if (!/accounts\.google\.com/i.test(page.url())) {
    const googleButton = page.getByRole('button', { name: GOOGLE_BUTTON })
      .or(page.getByRole('link', { name: GOOGLE_BUTTON }))
      .first();
    if (!await googleButton.isVisible().catch(() => false)) {
      throw new Error('Supabase Google sign-in control is unavailable');
    }
    authPage = await clickToOAuthPage(page.context(), page, googleButton);
  }
  const signedIn = await googleSso(activeSession, credentials, { page: authPage, originHost: 'supabase.com' });
  if (!signedIn) throw new Error(`Google SSO failed for ${accountEmail}`);
  await page.waitForURL(/supabase\.com\/dashboard/);
}

/** Try Figma's own email + password form first; true when it established a session. */
async function figmaDirectLogin(page, credentials) {
  const emailInput = page.locator('input[type="email"], input[name="email"]').filter({ visible: true }).first();
  if (!await emailInput.isVisible().catch(() => false)) return false;
  await humanFill(page, emailInput, credentials.email);
  const continueButton = page.getByRole('button', { name: /^(continue|log in)$/i }).filter({ visible: true }).first();
  if (!await continueButton.isVisible().catch(() => false)) return false;
  await humanClickLocator(page, continueButton);
  await pageSettled(page);
  const passwordInput = page.locator('input[type="password"], input[name="password"]').filter({ visible: true }).first();
  if (!await passwordInput.isVisible()) return false;
  await humanFill(page, passwordInput, credentials.password);
  await page.keyboard.press('Enter');
  await pageSettled(page);
  if (!FIGMA_LOGIN.test(page.url())) {
    console.log('[figma_sso] established Figma session with direct credentials');
    return true;
  }
  console.log('[figma_sso] direct credential login did not establish a session; using Google SSO');
  return false;
}

/** Sign the session into Figma when the task acquires a Figma token, by password or Google SSO. */
export async function ensureFigmaSession(activeSession, taskConstraints) {
  if (taskConstraints.secret !== 'figma.personal_access_token') return;

  const accountEmail = typeof taskConstraints.account_email === 'string'
    ? taskConstraints.account_email.trim().toLowerCase()
    : '';
  if (!accountEmail) throw new Error('Figma token acquisition requires an exact account email');

  const page = activeSession.page;
  const context = page.context();
  let recoveryPage = false;
  await page.waitForLoadState?.('domcontentloaded').catch(noteCutShort('figma load'));
  const googleButton = page.getByRole('button', { name: GOOGLE_BUTTON })
    .or(page.getByRole('link', { name: GOOGLE_BUTTON }))
    .first();
  const requiresSignIn = /\/login(?:[/?#]|$)|accounts\.google\.com/i.test(page.url())
    || await googleButton.isVisible().catch(() => false);
  if (!requiresSignIn) return;

  const credentials = await getGoogleSsoCreds(accountEmail);
  if (!credentials) throw new Error(`Google SSO credentials are unavailable for ${accountEmail}`);
  const keepOAuthPageOpen = () => {
    Object.defineProperty(window, 'close', {
      configurable: false,
      value: () => undefined,
      writable: false,
    });
  };
  await context.addInitScript(keepOAuthPageOpen);
  await page.evaluate(keepOAuthPageOpen).catch(noteCutShort('figma keep-open'));

  if (await figmaDirectLogin(page, credentials)) return;

  let authPage = page;
  if (!/accounts\.google\.com/i.test(page.url())) {
    recoveryPage = await context.newPage();
    await recoveryPage.goto('about:blank');
    const buttonMetadata = await googleButton.evaluate((element) => ({
      tag: element.tagName,
      href: element instanceof HTMLAnchorElement ? element.href : '',
      target: element instanceof HTMLAnchorElement ? element.target : '',
    }));
    console.log(`[figma_sso] Google control=${JSON.stringify(buttonMetadata)}`);
    authPage = await clickToOAuthPage(context, page, googleButton);
  }
  const signedIn = await googleSso(activeSession, credentials, { page: authPage, originHost: 'figma.com' });
  if (!signedIn) throw new Error(`Figma Google SSO failed for ${accountEmail}`);
  const availablePages = context.pages();
  const liveFigmaPages = availablePages.filter((candidate) => (
    !candidate.isClosed?.() && /figma\.com/i.test(candidate.url())
  ));
  const liveFigmaPage = liveFigmaPages.find((candidate) => !FIGMA_LOGIN.test(candidate.url())) ?? liveFigmaPages[0];
  console.log(`[figma_sso] pages after Google SSO=${JSON.stringify(availablePages.map((candidate) => ({
    closed: candidate.isClosed?.() ?? false,
    url: candidate.url(),
  })))}`);
  const targetPage = page.isClosed?.() ? (liveFigmaPage ?? recoveryPage) : page;
  if (targetPage !== page) activeSession.page = targetPage;
  if (!targetPage || targetPage.isClosed?.()) {
    throw new Error(`Figma closed every recoverable page after Google SSO for ${accountEmail}`);
  }
  if (!FIGMA_LOGIN.test(targetPage.url())) await targetPage.waitForURL(/figma\.com\/(files|settings)/);
  if (FIGMA_LOGIN.test(targetPage.url())) {
    await targetPage.goto('https://www.figma.com/settings?tab=security');
    await targetPage.waitForLoadState?.('domcontentloaded').catch(noteCutShort('figma settings load'));
  }
  if (FIGMA_LOGIN.test(targetPage.url())) {
    throw new Error(`Figma did not establish a session for ${accountEmail}`);
  }
}
