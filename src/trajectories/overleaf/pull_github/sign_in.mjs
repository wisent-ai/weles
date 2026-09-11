// Signing in to Overleaf through Google SSO, in a popup or in place, and settling on the
// dashboard; persisted cookies skip the SSO entirely.
import { googleSso } from '../../_shared/services/google_sso.mjs';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { captureOverleafAuth, dieUI, shot, waitMs } from './evidence.mjs';

export async function findGoogleSsoSurface(s, googleBtn) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    console.log(`[pull_github] clicking Google SSO button (attempt ${attempt})`);
    let popupCaught = null;
    const popupPromise = s.page.waitForEvent('popup').then((p) => { popupCaught = p; return p; }, () => null);
    await humanClickLocator(s.page, googleBtn);
    const popup = await Promise.race([
      popupPromise,
      waitMs(5000),  // allow-raw-playwright: bounded popup detection
    ]);
    if (popup || popupCaught) return { mode: 'popup', page: popup || popupCaught };
    for (let i = 0; i < 40; i += 1) {
      for (const p of s.ctx.pages()) {
        if (p !== s.page && /accounts\.google\.com/.test(p.url())) return { mode: 'popup', page: p };
      }
      if (/accounts\.google\.com/.test(s.page.url())) return { mode: 'main', page: s.page };
      await s.page.waitForTimeout(250);  // allow-raw-playwright: SSO surface poll
    }
    await shot(s, `google_sso_not_opened_${attempt}`);
  }
  return null;
}

export async function signInToOverleaf(s, sessionStore, login) {
  await s.goto('https://www.overleaf.com/login');
  await humanIdlePause('short');

  if (/\/project(\?|$|\/)/.test(s.page.url())) {
    console.log('[pull_github] already authenticated via persisted cookies');
    await captureOverleafAuth(sessionStore, s, 'already-authenticated');
  } else {
    const cookieBtn = s.page.getByRole('button', { name: /essential cookies only|accept all cookies/i }).first();
    if (await cookieBtn.count() > 0) {
      console.log('[pull_github] dismissing cookie banner');
      await humanClickLocator(s.page, cookieBtn);
      await s.page.waitForTimeout(500);  // allow-raw-playwright: cookie-banner settle
    }
    const googleBtn = s.page.getByRole('button', { name: /log in with google|sign in with google/i }).or(
      s.page.getByRole('link', { name: /log in with google|sign in with google/i })
    ).first();
    await googleBtn.waitFor({ state: 'visible' });
    const surface = await findGoogleSsoSurface(s, googleBtn);
    if (!surface) {
      await dieUI(s, 'google_sso_surface', 'clicking the Google login button did not open accounts.google.com in the main page or a popup');
    }

    if (surface.mode === 'popup') {
      console.log('[pull_github] Google SSO in popup');
      await surface.page.waitForLoadState('domcontentloaded');
      const ok = await googleSso(s, login, { originHost: 'overleaf.com', page: surface.page });
      if (!ok) { console.error('FAIL: Google SSO did not complete (popup)'); await s.close(); process.exit(1); }
    } else {
      console.log('[pull_github] Google SSO in-place redirect');
      const ok = await googleSso(s, login, { originHost: 'overleaf.com' });
      if (!ok) { console.error('FAIL: Google SSO did not complete (in-place)'); await s.close(); process.exit(1); }
    }

    let prev = '';
    let stableTicks = 0;
    let settledUrl = null;
    for (let i = 0; i < 60; i += 1) {
      await s.page.waitForTimeout(500);  // allow-raw-playwright: settle poll
      const u = s.page.url();
      if (u !== prev) { prev = u; stableTicks = 0; continue; }
      stableTicks += 1;
      if (stableTicks >= 3 && !/accounts\.google\.com/.test(u)) { settledUrl = u; break; }
    }
    let finalUrl = settledUrl;
    if (finalUrl === null) finalUrl = s.page.url();
    console.log(`[pull_github] settled URL: ${finalUrl}`);
    if (/\/login(\?|$|\/)/.test(finalUrl)) {
      await dieUI(s, 'sso', `Overleaf returned to /login after SSO (auth not established) — ${finalUrl}`);
    }
    if (!/\/project(\?|$|\/)/.test(finalUrl)) {
      await s.goto('https://www.overleaf.com/project');
    }
    await captureOverleafAuth(sessionStore, s, 'post-sso');
  }
}
