import { humanIdlePause } from '../../../../dist/human/mouse.js';
import { screenshotIfPossible } from '../../_shared/runner/evidence.mjs';

/** Whether the context holds TikTok's httpOnly sessionid cookie. */
async function hasSessionCookie(ctx) {
  const cookies = await ctx.cookies();
  return cookies.some((c) => c.name === 'sessionid' && (c.domain || '').includes('tiktok'));
}

/** What the login form and any captcha or error surface look like right now. */
function readFinalState(page) {
  return page.evaluate(() => {
    const u = document.querySelector('input[name="username"]');
    const p = document.querySelector('input[type="password"]');
    const b = document.querySelector('button[data-e2e="login-button"]');
    const errs = Array.from(document.querySelectorAll('[class*="error" i], [data-e2e*="error" i]')).map(el => el.textContent?.trim()).filter(Boolean);
    const captchas = Array.from(document.querySelectorAll('[class*="captcha" i], [class*="verify" i], iframe[src*="captcha" i], iframe[src*="verification" i]')).map(el => ({ tag: el.tagName, src: el.getAttribute('src'), cls: el.className?.toString?.()?.slice(0, 100) }));
    // Captcha image structure dump — look for img elements in the captcha modal
    const modal = document.querySelector('.captcha-verify-container, .captcha_verify_container, [class*="captcha-"]');
    let captchaDom = null;
    if (modal) {
      const imgs = Array.from(modal.querySelectorAll('img')).map(i => {
        const r = i.getBoundingClientRect();
        return { src: i.src?.slice(0, 100), w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), alt: i.alt };
      });
      const slider = modal.querySelector('[class*="slider" i], [class*="drag" i], [aria-label*="slider" i]');
      const sliderRect = slider?.getBoundingClientRect();
      captchaDom = {
        modalCls: modal.className?.toString?.()?.slice(0, 200),
        imgs,
        sliderInfo: slider ? { tag: slider.tagName, cls: slider.className?.toString?.()?.slice(0, 100), x: Math.round(sliderRect.x), y: Math.round(sliderRect.y), w: Math.round(sliderRect.width), h: Math.round(sliderRect.height) } : null,
      };
    }
    return {
      url: location.href,
      usernameLen: u?.value?.length ?? -1,
      passwordLen: p?.value?.length ?? -1,
      buttonDisabled: b?.disabled,
      errors: errs.slice(0, 5),
      captchas: captchas.slice(0, 5),
      captchaDom,
    };
  }).catch((e) => ({ err: e.message }));
}

/**
 * Wait for the sessionid cookie plus navigation away from /login. The
 * sessionid cookie is httpOnly — document.cookie inside the page can't see
 * it — so the context's cookies are polled instead of waitForFunction. If the
 * login does not complete (wrong credentials, server error, captcha), this
 * records what the page shows in loginDiag.finalState and throws, so the
 * caller persists a ban_signal classified from the final URL.
 */
export async function waitForSignedIn(s, loginDiag) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const hasSession = await hasSessionCookie(s.ctx);
    const path = await s.page.evaluate('location.pathname').catch(() => '/login');
    if (hasSession && !String(path).startsWith('/login')) return;
    await humanIdlePause('short');
  }
  await screenshotIfPossible(s, 'post_submit_timeout');
  const finalState = await readFinalState(s.page);
  finalState.hasSessionId = await hasSessionCookie(s.ctx);
  loginDiag.finalState = finalState;
  console.log(`[tiktok_login] timeout finalState: ${JSON.stringify(finalState)}`);
  console.log(`[tiktok_login] timeout loginResponses: ${JSON.stringify(loginDiag.loginResponses)}`);
  if (loginDiag.accountApiError) throw new Error(`login_rate_limited: ${loginDiag.accountApiError}`);
  throw new Error('sessionid+url wait timeout');
}
