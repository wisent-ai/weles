import { pageSettled } from '../../_shared/page/settled.mjs';
import { screenshotIfPossible } from '../../_shared/runner/evidence.mjs';

/** Whether the context holds TikTok's httpOnly sessionid cookie. */
async function hasSessionCookie(ctx) {
  const cookies = await ctx.cookies();
  return cookies.some(
    (c) => c.name === 'sessionid' && (c.domain || '').includes('tiktok'),
  );
}

/** What the login form and any captcha or error surface look like right now. */
function readFinalState(page) {
  return page
    .evaluate(() => {
      const u = document.querySelector('input[name="username"]');
      const p = document.querySelector('input[type="password"]');
      const b = document.querySelector('button[data-e2e="login-button"]');
      const errs = Array.from(
        document.querySelectorAll('[class*="error" i], [data-e2e*="error" i]'),
      )
        .map((el) => el.textContent?.trim())
        .filter(Boolean);
      const captchas = Array.from(
        document.querySelectorAll(
          '[class*="captcha" i], [class*="verify" i], iframe[src*="captcha" i], iframe[src*="verification" i]',
        ),
      ).map((el) => ({
        tag: el.tagName,
        src: el.getAttribute('src'),
        cls: el.className?.toString?.(),
      }));
      // Captcha image structure dump — look for img elements in the captcha modal
      const modal = document.querySelector(
        '.captcha-verify-container, .captcha_verify_container, [class*="captcha-"]',
      );
      let captchaDom = null;
      if (modal) {
        const imgs = Array.from(modal.querySelectorAll('img')).map((i) => {
          const r = i.getBoundingClientRect();
          return {
            src: i.src,
            w: Math.round(r.width),
            h: Math.round(r.height),
            x: Math.round(r.x),
            y: Math.round(r.y),
            alt: i.alt,
          };
        });
        const slider = modal.querySelector(
          '[class*="slider" i], [class*="drag" i], [aria-label*="slider" i]',
        );
        const sliderRect = slider?.getBoundingClientRect();
        captchaDom = {
          modalCls: modal.className?.toString?.(),
          imgs,
          sliderInfo: slider
            ? {
                tag: slider.tagName,
                cls: slider.className?.toString?.(),
                x: Math.round(sliderRect.x),
                y: Math.round(sliderRect.y),
                w: Math.round(sliderRect.width),
                h: Math.round(sliderRect.height),
              }
            : null,
        };
      }
      return {
        url: location.href,
        usernameLen: u?.value?.length ?? -1,
        passwordLen: p?.value?.length ?? -1,
        buttonDisabled: b?.disabled,
        errors: errs,
        captchas: captchas,
        captchaDom,
      };
    })
    .catch((e) => ({ err: e.message }));
}

/**
 * Wait for the login to end one way or another: the page leaves /login, or
 * an error or captcha surface appears. Then the httpOnly sessionid cookie
 * (which document.cookie cannot see) decides. A login that did not complete
 * records what the page shows in loginDiag.finalState and throws, so the
 * caller persists a ban_signal classified from the final URL.
 */
export async function waitForSignedIn(s, loginDiag) {
  const page = s.page;
  await Promise.any([
    page.waitForURL(
      (url) => !new URL(String(url)).pathname.startsWith('/login'),
    ),
    page
      .locator('[class*="error" i], [data-e2e*="error" i]')
      .filter({ visible: true })
      .first()
      .waitFor({ state: 'visible' }),
    page
      .locator(
        '[class*="captcha" i], iframe[src*="captcha" i], iframe[src*="verification" i]',
      )
      .filter({ visible: true })
      .first()
      .waitFor({ state: 'visible' }),
  ]);
  await pageSettled(page);
  const path = new URL(page.url()).pathname;
  if ((await hasSessionCookie(s.ctx)) && !path.startsWith('/login')) return;
  await screenshotIfPossible(s, 'post_submit_not_signed_in');
  const finalState = await readFinalState(page);
  finalState.hasSessionId = await hasSessionCookie(s.ctx);
  loginDiag.finalState = finalState;
  console.log(
    `[tiktok_login] not signed in, finalState: ${JSON.stringify(finalState)}`,
  );
  console.log(
    `[tiktok_login] loginResponses: ${JSON.stringify(loginDiag.loginResponses)}`,
  );
  if (loginDiag.accountApiError)
    throw new Error(`login_rate_limited: ${loginDiag.accountApiError}`);
  throw new Error(
    `tiktok login did not sign in: at ${path}, sessionid=${finalState.hasSessionId}, errors=${JSON.stringify(finalState.errors ?? [])}`,
  );
}
