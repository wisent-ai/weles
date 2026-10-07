// Signing in to Overleaf through Google SSO, the one way every Overleaf
// trajectory does it.
//
// Nothing here counts or sleeps: the Google surface is whichever comes first
// of a popup or the page itself moving to accounts.google.com, and the sign-in
// is over when the page has left Google and settled. A sign-in that ends back
// on Overleaf's /login throws with the URL it ended on.
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { googleSso } from './google_sso.mjs';
import { pageSettled } from '../page/settled.mjs';

const ON_GOOGLE = /accounts\.google\.com/;
const ON_PROJECTS = /\/project(\?|$|\/)/;
const ON_LOGIN = /\/login(\?|$|\/)/;

/**
 * @param {object} s WSession
 * @param {object} login Google login material for googleSso
 * @param {{ label: string, chooseAnotherAccount?: boolean }} options
 * @returns {Promise<{ alreadySignedIn: boolean, url: string }>}
 */
export async function overleafGoogleSignIn(s, login, options) {
  const { label, chooseAnotherAccount = false } = options;
  await s.goto('https://www.overleaf.com/login');
  await pageSettled(s.page);
  if (ON_PROJECTS.test(s.page.url())) {
    console.log(`[${label}] already authenticated via persisted cookies`);
    return { alreadySignedIn: true, url: s.page.url() };
  }

  const cookieBtn = s.page
    .getByRole('button', { name: /essential cookies only|accept all cookies/i })
    .first();
  if ((await cookieBtn.count()) > 0) {
    console.log(`[${label}] dismissing cookie banner`);
    await humanClickLocator(s.page, cookieBtn);
    await pageSettled(s.page);
  }
  const googleBtn = s.page
    .getByRole('button', { name: /log in with google|sign in with google/i })
    .or(
      s.page.getByRole('link', {
        name: /log in with google|sign in with google/i,
      }),
    )
    .filter({ visible: true })
    .first();
  await googleBtn.waitFor({ state: 'visible' });

  const popup = s.page.waitForEvent('popup');
  const inPlace = s.page.waitForURL(ON_GOOGLE).then(() => s.page);
  await humanClickLocator(s.page, googleBtn);
  const surface = await Promise.any([popup, inPlace]);
  const mode = surface === s.page ? 'in-place' : 'popup';
  console.log(`[${label}] Google SSO ${mode}`);
  await surface.waitForLoadState('domcontentloaded');

  if (chooseAnotherAccount) {
    const emailInputs = await surface
      .locator(
        'input[type="email"], input[name="identifier"], input#identifierId',
      )
      .filter({ visible: true })
      .count();
    const useAnother = surface
      .getByText(/Use another account/i)
      .filter({ visible: true })
      .first();
    if (emailInputs === 0 && (await useAnother.count()) > 0) {
      await humanClickLocator(surface, useAnother);
      await pageSettled(surface);
    }
  }

  const ok = await googleSso(
    s,
    login,
    mode === 'popup'
      ? { originHost: 'overleaf.com', page: surface }
      : { originHost: 'overleaf.com' },
  );
  if (!ok)
    throw new Error(
      `Google SSO for Overleaf did not complete (${mode}) at ${surface.url()}`,
    );

  await s.page.waitForURL((url) => !ON_GOOGLE.test(String(url)));
  await pageSettled(s.page);
  const url = s.page.url();
  console.log(`[${label}] settled URL: ${url}`);
  if (ON_LOGIN.test(url))
    throw new Error(
      `Overleaf returned to /login after Google SSO (auth not established) — ${url}`,
    );
  return { alreadySignedIn: false, url };
}
