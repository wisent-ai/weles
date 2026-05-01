import { getSocialAccount, resolveAccountSession } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { humanType } from '../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../dist/human/mouse.js';

const PASSWORD_URL = 'https://www.tiktok.com/login/phone-or-email/email?lang=en';
const FEED_URL = 'https://www.tiktok.com/foryou?lang=en';

/**
 * Solve TikTok rotate captcha via SadCaptcha API.
 * Returns true if captcha solved + dismissed, false otherwise.
 */
async function solveTiktokRotateCaptcha(page) {
  const apiKey = process.env.SADCAPTCHA_API_KEY;
  if (!apiKey) { console.log('[tt-captcha] SADCAPTCHA_API_KEY missing — cannot solve'); return false; }
  // Wait for captcha modal AND at least 2 images to be loaded (up to 12s).
  for (let w = 0; w < 24; w++) {
    const ready = await page.evaluate(() => {
      const m = document.querySelector('.captcha-verify-container, .captcha_verify_container, [class*="captcha-"]');
      if (!m) return false;
      const imgs = Array.from(m.querySelectorAll('img')).filter((i) => {
        const r = i.getBoundingClientRect();
        return r.width > 50 && r.height > 50 && i.src && i.src.startsWith('data:');
      });
      return imgs.length >= 2;
    }).catch(() => false);
    if (ready) break;
    await page.waitForTimeout(500);
  }
  // Extract images + slider track + button geometry from the modal.
  const probe = await page.evaluate(() => {
    const modal = document.querySelector('.captcha-verify-container, .captcha_verify_container, [class*="captcha-"]');
    if (!modal) return null;
    const imgs = Array.from(modal.querySelectorAll('img'))
      .map((i) => {
        const r = i.getBoundingClientRect();
        return { src: i.src, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), alt: i.alt };
      })
      .filter((m) => m.w > 0 && m.h > 0);
    if (imgs.length < 2) return { reason: 'fewer than 2 images', imgs };
    // Outer = larger, inner = smaller
    imgs.sort((a, b) => b.w - a.w);
    const outer = imgs[0];
    const inner = imgs[1];
    // Slider button (the draggable handle, usually has secsdk-captcha-drag-icon class
    // or is a button inside the modal at the bottom).
    const sliderBtn = modal.querySelector('.secsdk-captcha-drag-icon, [class*="drag-icon"], [class*="slide-button"]');
    let sliderInfo = null;
    if (sliderBtn) {
      const r = sliderBtn.getBoundingClientRect();
      sliderInfo = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    } else {
      // Fallback: lowest-Y button inside modal
      const buttons = Array.from(modal.querySelectorAll('button')).filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 20 && r.height > 20;
      });
      buttons.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y);
      const cand = buttons[0];
      if (cand) {
        const r = cand.getBoundingClientRect();
        sliderInfo = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      }
    }
    // Slider track — walk up parents until we find one significantly wider
    // than the button (the visual track typically spans the captcha modal
    // width: ~280px on standard TikTok rotate).
    let trackInfo = null;
    if (sliderBtn) {
      let p = sliderBtn.parentElement;
      while (p && p !== modal) {
        const r = p.getBoundingClientRect();
        if (r.width >= sliderInfo.w * 2 && r.height < 80) {
          trackInfo = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
          break;
        }
        p = p.parentElement;
      }
    }
    return { outer, inner, sliderInfo, trackInfo };
  }).catch((e) => ({ err: e.message }));
  if (!probe || probe.err || !probe.outer || !probe.inner || !probe.sliderInfo) {
    console.log(`[tt-captcha] probe failed: ${JSON.stringify(probe)}`);
    return false;
  }
  console.log(`[tt-captcha] outer=${probe.outer.w}x${probe.outer.h} inner=${probe.inner.w}x${probe.inner.h} slider=${probe.sliderInfo.w}x${probe.sliderInfo.h} track=${probe.trackInfo?.w}x${probe.trackInfo?.h}`);
  // Strip the data:image/...;base64, prefix from the image URLs.
  const stripPrefix = (u) => u.replace(/^data:[^,]+,/, '');
  const outerB64 = stripPrefix(probe.outer.src);
  const innerB64 = stripPrefix(probe.inner.src);
  // POST to SadCaptcha rotate endpoint.
  let angle = 0;
  try {
    const resp = await fetch(`https://www.sadcaptcha.com/api/v1/rotate?licenseKey=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outerImageB64: outerB64, innerImageB64: innerB64 }),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      console.log(`[tt-captcha] sadcaptcha api status=${resp.status} body=${txt.slice(0, 200)}`);
      return false;
    }
    const j = await resp.json();
    angle = Number(j?.angle ?? 0);
    console.log(`[tt-captcha] sadcaptcha returned angle=${angle}`);
  } catch (e) {
    console.log(`[tt-captcha] sadcaptcha api error: ${e.message}`);
    return false;
  }
  if (!angle || isNaN(angle)) { console.log('[tt-captcha] zero/NaN angle'); return false; }
  // Calculate slider drag distance.
  // GitHub docs formula: result = ((slide_bar_width - slide_button_width) * angle) / 360
  // The track width in TikTok web rotate is the inner image width (~280px on
  // mobile, varies on desktop). Use the parent container width as approx.
  const trackWidth = probe.trackInfo?.w ?? 280;
  const buttonWidth = probe.sliderInfo.w;
  const dragX = Math.round(((trackWidth - buttonWidth) * angle) / 360);
  console.log(`[tt-captcha] dragging slider by ${dragX}px (trackW=${trackWidth} btnW=${buttonWidth})`);
  // Drag the slider — start at the centre of the slider button, move
  // smoothly to the target X with multiple intermediate points (mimicking
  // human drag).
  const startX = probe.sliderInfo.x + Math.floor(probe.sliderInfo.w / 2);
  const startY = probe.sliderInfo.y + Math.floor(probe.sliderInfo.h / 2);
  const endX = startX + dragX;
  await page.mouse.move(startX, startY, { steps: 5 });
  await page.waitForTimeout(150);
  await page.mouse.down();
  // Move in 30 small steps over ~1.5s, with slight Y jitter.
  const steps = 30;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // Ease-out: most movement early, slight tail
    const ease = 1 - Math.pow(1 - t, 2);
    const x = startX + Math.round(dragX * ease);
    const y = startY + (Math.random() < 0.3 ? (Math.random() < 0.5 ? -1 : 1) : 0);
    await page.mouse.move(x, y);
    await page.waitForTimeout(35 + Math.floor(Math.random() * 25));
  }
  await page.waitForTimeout(120);
  await page.mouse.up();
  // Wait up to 5s for the modal to disappear.
  for (let w = 0; w < 10; w++) {
    await page.waitForTimeout(500);
    const stillThere = await page.evaluate(() => !!document.querySelector('.captcha-verify-container, .captcha_verify_container')).catch(() => true);
    if (!stillThere) {
      console.log('[tt-captcha] modal dismissed — captcha solved');
      return true;
    }
  }
  console.log('[tt-captcha] modal still present after drag — solve failed');
  return false;
}

const acct = await getSocialAccount('tiktok');
if (!acct) { console.log('FAIL: no active tiktok account in DB'); process.exit(1); }
process.env.SVC_EMAIL = acct.metadata.email ?? acct.username;
process.env.SVC_PASSWORD = acct.metadata.password ?? '';
console.log(`[trajectory] Using account: ${acct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'tiktok_login', proxy: proxyUrl, persona });

async function captureCookies() {
  if (!acct.id) return;
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !key) return;
  try {
    const cookies = await s.ctx.cookies();
    const r = await fetch(`${supabaseUrl}/rest/v1/social_accounts?id=eq.${acct.id}&select=metadata`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    const rows = await r.json();
    const merged = { ...(rows?.[0]?.metadata ?? {}), cookies };
    await fetch(`${supabaseUrl}/rest/v1/social_accounts?id=eq.${acct.id}`, {
      method: 'PATCH',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ metadata: merged }),
    });
    console.log(`[cookie-capture] refreshed ${cookies.length} cookies for account ${acct.id}`);
  } catch (e) { console.log('[cookie-capture] err:', e.message); }
}

// REMOVED tryCookieFirstLogin — see auth-probe.mjs header comment for full
// rationale. Short version: cookies present + URL didn't bounce ≠ session is
// authed. TikTok serves /foryou and /messages with logged-out shells when
// the session is device-mismatched, so cookie-first declared PASS while the
// comment input never rendered for the supposedly-logged-in user. Login
// always means form login now. Action trajectories use assertAuthed() from
// auth-probe.mjs to verify a session is real.
async function _removedCookieFirstLogin_doNotReintroduce() {
  const stored = Array.isArray(acct.metadata?.cookies) ? acct.metadata.cookies : [];
  if (stored.length === 0) return false;

  // Playwright requires url OR domain+path. Normalize any stored cookie shapes
  // that drop path, and filter out anything missing the core fields.
  const prepared = stored
    .filter((c) => c && c.name && c.value && (c.domain || c.url))
    .map((c) => ({ ...c, path: c.path || '/' }));

  if (prepared.length === 0) return false;

  try {
    await s.ctx.addCookies(prepared);
    console.log(`[trajectory] injected ${prepared.length} stored cookies — trying cookie-first login`);
  } catch (e) {
    console.log(`[trajectory] cookie inject failed: ${e.message?.slice(0, 200)}`);
    return false;
  }

  await s.goto(FEED_URL);
  await s.page.waitForLoadState('domcontentloaded').catch(() => {});
  // Give the TikTok SPA time to hydrate the nav rail + top bar before we
  // probe for logged-in markers.
  await new Promise((r) => setTimeout(r, 4000));

  const url = s.page.url();
  // If the browser was redirected to /login or /passport, the server rejected
  // our cookies and we're not authed.
  if (/\/login|\/passport/i.test(url)) {
    await s.screenshot('cookie_first_redirected_to_login').catch(() => {});
    return false;
  }
  // Definitive auth check: navigate to /messages — TikTok hard-redirects
  // unauthenticated users to /login?redirect_url=/messages here. The /foryou
  // page on its own is a *lying* indicator: TikTok serves /foryou (with
  // public videos) to logged-out users too, so "stayed on /foryou" was
  // always a false positive.
  //
  // Verified 2026-04-29: user9903356330248 had sessionid in cookies, /foryou
  // didn't bounce, BUT /messages redirected to /login — proving the saved
  // session was NOT actually authenticated. The msToken cookie had expired
  // ~2 months prior (saved 2026-02, current date 2026-04). TikTok's auth
  // requires BOTH a fresh msToken AND sessionid; only sessionid was valid.
  await s.page.goto('https://www.tiktok.com/messages', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 4000));
  const messagesUrl = s.page.url();
  if (/\/login|\/passport/i.test(messagesUrl)) {
    console.log(`[trajectory] cookie-first failed: /messages redirected to ${messagesUrl}`);
    await s.screenshot('cookie_first_messages_login_redirect').catch(() => {});
    return false;
  }
  // /messages stayed put — session is genuinely authenticated.
  await s.screenshot('cookie_first_ok').catch(() => {});
  return true;
}

try {
  // Cookie-first removed — login always means form login. See auth-probe.mjs.
  {
    // Pre-seed TikTok region cookies so the page skips the cross-origin
    // /passport/web/region/ probe (which is flaky through residential
    // proxies — sometimes returns ERR_FAILED on CORS preflight, breaking
    // the entire login form). Setting these cookies tells the page we're
    // already in US/EN locale and the region detector short-circuits.
    await s.ctx.addCookies([
      { name: 'tt-target-idc', value: 'useast5', domain: '.tiktok.com', path: '/', httpOnly: false, secure: true, sameSite: 'Lax' },
      { name: 'tt_chain_token', value: '', domain: '.tiktok.com', path: '/', httpOnly: false, secure: true, sameSite: 'Lax' },
      { name: 'cmpl_token', value: '', domain: '.tiktok.com', path: '/', httpOnly: false, secure: true, sameSite: 'Lax' },
      { name: 'store-idc', value: 'useast5', domain: '.tiktok.com', path: '/', httpOnly: false, secure: true, sameSite: 'Lax' },
      { name: 'store-country-code', value: 'us', domain: '.tiktok.com', path: '/', httpOnly: false, secure: true, sameSite: 'Lax' },
      { name: 'store-country-code-src', value: 'uid', domain: '.tiktok.com', path: '/', httpOnly: false, secure: true, sameSite: 'Lax' },
    ]).catch((e) => console.log(`[trajectory] region cookie seed failed: ${e.message}`));
    // Deterministic email/password login. The TikTok login form has stable selectors:
    //   input[name="username"] (email/phone)
    //   input[type="password"]
    //   button[data-e2e="login-button"]
    await s.goto(PASSWORD_URL);
    const emailIn = s.page.locator('input[name="username"], input[type="text"][placeholder*="email" i], input[type="email"]').filter({ visible: true }).first();
    const pwIn = s.page.locator('input[type="password"]').filter({ visible: true }).first();
    await emailIn.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, emailIn);
    await humanIdlePause('short');
    await humanType(s.page, process.env.SVC_EMAIL);
    await humanIdlePause('short');
    await humanClickLocator(s.page, pwIn);
    await humanIdlePause('short');
    await humanType(s.page, process.env.SVC_PASSWORD);
    await humanIdlePause('short');
    // Diagnostic: snapshot field values + button enabled state right before
    // the click. If button is still disabled, typing didn't fully register.
    const formState = await s.page.evaluate(() => {
      const u = document.querySelector('input[name="username"]');
      const p = document.querySelector('input[type="password"]');
      const b = document.querySelector('button[data-e2e="login-button"]');
      return {
        usernameLen: u?.value?.length ?? -1,
        passwordLen: p?.value?.length ?? -1,
        buttonDisabled: b?.disabled,
        buttonAria: b?.getAttribute('aria-disabled'),
      };
    }).catch((e) => ({ err: e.message }));
    console.log(`[tiktok_login] form-state pre-submit: ${JSON.stringify(formState)}`);
    await s.screenshot('pre_submit').catch(() => {});

    const submitBtn = s.page.locator('button[data-e2e="login-button"], button[type="submit"]').filter({ visible: true }).first();
    // Capture network responses for /passport/web/login/ to see if submit fired
    const loginResponses = [];
    const failedRequests = [];
    s.page.on('response', (res) => {
      const u = res.url();
      if (/\/passport\/web\/login|\/passport\/web\/login_with_email|\/passport\/web\/account_check/.test(u)) {
        loginResponses.push({ url: u, status: res.status(), ts: Date.now() });
      }
    });
    s.page.on('requestfailed', (req) => {
      const u = req.url();
      const f = req.failure?.();
      if (/passport|tiktok|webmssdk|secsdk|verification|captcha/i.test(u)) {
        const headers = req.headers ? req.headers() : {};
        failedRequests.push({
          url: u.slice(0, 200),
          failure: f?.errorText,
          method: req.method(),
          origin: headers.origin || headers.referer?.slice(0, 80),
        });
      }
    });

    // Mock the flaky /passport/web/region/ endpoint so login proceeds even
    // when the residential proxy can't reach the regional CDN. The page's
    // getMaxNumberDomain() reads {data.domain, data.ttwid_migration_ticket}
    // from each response and picks the majority domain. Returning
    // www.tiktok.com keeps subsequent passport calls same-origin (no CORS
    // preflight needed).
    await s.page.route(/\/passport\/web\/region\//, async (route) => {
      const req = route.request();
      console.log(`[tiktok_login] mocking region: ${req.url().slice(0, 100)}`);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'Access-Control-Allow-Origin': 'https://www.tiktok.com',
          'Access-Control-Allow-Credentials': 'true',
        },
        body: JSON.stringify({
          message: 'success',
          data: {
            domain: 'www.tiktok.com',
            ttwid_migration_ticket: '',
            error_code: 0,
          },
        }),
      });
    });
    s.page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        console.log(`[tiktok_login] page-${msg.type()}: ${msg.text().slice(0, 200)}`);
      }
    });
    await humanClickLocator(s.page, submitBtn);
    console.log(`[tiktok_login] submit clicked, waiting for sessionid (${loginResponses.length} login XHR captured so far)`);
    await s.page.waitForTimeout(3000);
    await s.screenshot('post_submit_3s').catch(() => {});
    console.log(`[tiktok_login] +3s loginResponses=${JSON.stringify(loginResponses)}`);
    console.log(`[tiktok_login] +3s failedRequests=${JSON.stringify(failedRequests.slice(0, 10))}`);
    // Check for captcha modal — if present, solve via SadCaptcha and re-submit.
    const captchaPresent = await s.page.evaluate(() =>
      !!document.querySelector('.captcha-verify-container, .captcha_verify_container, [class*="captcha-"]')
    ).catch(() => false);
    if (captchaPresent) {
      console.log('[tiktok_login] captcha modal detected — attempting SadCaptcha solve');
      const solved = await solveTiktokRotateCaptcha(s.page);
      if (!solved) {
        await s.screenshot('captcha_solve_failed').catch(() => {});
        throw new Error('captcha_challenge: SadCaptcha solve failed');
      }
      // After captcha solves, TikTok auto-submits the original form. Wait
      // for the login XHR.
      await s.page.waitForTimeout(2000);
      console.log(`[tiktok_login] post-captcha loginResponses=${JSON.stringify(loginResponses)}`);
    }
    // Wait for sessionid cookie + navigation away from /login. The sessionid
    // cookie is httpOnly — document.cookie inside the page can't see it —
    // so poll s.ctx.cookies() (which returns httpOnly cookies too) instead
    // of waitForFunction. If the login does not complete (wrong credentials,
    // server error, captcha), this throws after the timeout and the outer
    // catch persists ban_signal with classified reason from final URL.
    try {
      const deadline = Date.now() + 30_000;
      let signedIn = false;
      while (Date.now() < deadline) {
        const ctxCookies = await s.ctx.cookies().catch(() => []);
        const hasSession = ctxCookies.some(c => c.name === 'sessionid' && (c.domain || '').includes('tiktok'));
        const path = await s.page.evaluate('location.pathname').catch(() => '/login');
        if (hasSession && !String(path).startsWith('/login')) { signedIn = true; break; }
        await s.page.waitForTimeout(500);
      }
      if (!signedIn) throw new Error('sessionid+url wait timeout');
    } catch (waitErr) {
      // Timed out — capture diagnostics before re-throwing
      await s.screenshot('post_submit_timeout').catch(() => {});
      const ctxCookies = await s.ctx.cookies().catch(() => []);
      const hasSessionIdHttpOnly = ctxCookies.some(c => c.name === 'sessionid' && (c.domain || '').includes('tiktok'));
      const finalState = await s.page.evaluate(() => {
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
      finalState.hasSessionId = hasSessionIdHttpOnly;
      console.log(`[tiktok_login] timeout finalState: ${JSON.stringify(finalState)}`);
      console.log(`[tiktok_login] timeout loginResponses: ${JSON.stringify(loginResponses)}`);
      throw waitErr;
    }
    console.log('PASS: logged in (deterministic email/password)');
    await captureCookies();
  }
} catch (e) {
  // Structured ban_signal so the worker doesn't fall back to 'unknown_error'.
  // TikTok login fails commonly at chrome-error proxy CONNECT, captcha widget
  // (SadCaptcha-gated), or error_code:7 rate-limit on register_verify_login.
  try {
    const path = await import('node:path');
    const fs = await import('node:fs');
    const dir = path.join(process.cwd(), 'recordings', 'tiktok_login');
    fs.mkdirSync(dir, { recursive: true });
    const finalUrl = s?.page?.url?.() ?? '';
    const msg = e.message ?? '';
    let sig = 'action_failed';
    if (/ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_BLOCKED_BY_RESPONSE|ERR_BLOCKED_BY_CLIENT|ERR_BLOCKED_BY_ADMINISTRATOR/.test(msg)) sig = 'ip_blocked';
    else if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/.test(msg)) sig = 'proxy_failed';
    else if (finalUrl.startsWith('chrome-error://')) sig = 'proxy_failed';
    else if (/captcha|verify-app|app-download/i.test(msg) || /\/login\/download-app|\/captcha/.test(finalUrl)) sig = 'captcha_challenge';
    else if (/\/login/.test(finalUrl)) sig = 'checkpoint';
    fs.writeFileSync(path.join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'tiktok_login', signal: sig, healthy: false, details: { final_url: finalUrl, reason: e.message?.slice(0, 200) ?? 'no message' }, ts: new Date().toISOString() }, null, 2));
  } catch {}
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
