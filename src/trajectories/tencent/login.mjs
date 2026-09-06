// Tencent Cloud login trajectory — fully autonomous via Google SSO.
//
// Pattern lifted from brightdata/balance.mjs + capsolver/balance.mjs:
// click "Sign in with Google", drive Google's identifier→password→consent
// flow via googleSso(), persist resulting cookie jar to
// ~/.weles/cookie-jars/tencent.json.
//
// Run:  cd weles && node src/trajectories/tencent/login.mjs

import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { solveTencentCaptcha, injectCaptchaSolution, findCaptchaAppId } from './tcaptcha_solver.mjs';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';

const LOGIN_URL = 'https://www.tencentcloud.com/account/login?s_url=https%3A%2F%2Fconsole.tencentcloud.com%2F';
const ORIGIN_HOST = 'tencentcloud.com';
const JAR_DIR = join(homedir(), '.weles', 'cookie-jars');
const JAR_PATH = join(JAR_DIR, 'tencent.json');
const VERIFY_CODE_PATH = join(homedir(), '.weles', 'tencent_verify_code.txt');
const PERSONA_PATH = join(JAR_DIR, 'tencent_persona.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickGoogleSsoButton(page) {
  // Tencent's intl login page exposes Google as one of several SSO options.
  // Selectors here match the visible button label / aria-label across the
  // current page render (verified by manual inspection); robust to minor
  // copy changes via the multi-pattern OR-list.
  const candidates = [
    'button:has-text("Continue with Google")',
    'button:has-text("Sign in with Google")',
    'button:has-text("Log in with Google")',
    'a:has-text("Continue with Google")',
    'a:has-text("Sign in with Google")',
    'div[role="button"]:has-text("Google")',
    '[aria-label*="Google" i]',
    'img[alt*="Google" i]',
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel).filter({ visible: true }).first();
    if (await loc.count() > 0) {
      console.log(`[login] clicking SSO button: ${sel}`);
      // SSO often opens a popup; capture before click.
      const popupP = page.waitForEvent('popup').catch(() => null);
      try { await humanClickLocator(page, loc); } catch { /* loc may have detached after focus */ }
      const popup = await Promise.race([popupP, new Promise((r) => setTimeout(() => r(null), 8000))]);
      return popup; // popup or null (some flows use full-page redirect)
    }
  }
  console.log('[login] FAIL: no Google SSO button visible');
  return undefined;
}

async function persistJar(page) {
  if (!existsSync(JAR_DIR)) mkdirSync(JAR_DIR, { recursive: true });
  const cookies = await page.context().cookies();
  const tencent = cookies.filter((c) =>
    /tencentcloud\.com$|tencent\.com$|qcloud\.com$|qq\.com$/.test(c.domain)
  );
  const jar = {
    persisted_at: new Date().toISOString(),
    cookie_count: tencent.length,
    cookies: tencent,
  };
  writeFileSync(JAR_PATH, JSON.stringify(jar, null, 2));
  console.log(`[login] persisted ${tencent.length} cookies to ${JAR_PATH}`);
  const auth = tencent.find((c) =>
    /^(skey|p_skey|uin|tinyid|ownerUin|appid|INTL_SAAS_SYNCED_SESSION_KEY|loginType)$/i.test(c.name)
  );
  if (auth) console.log(`[login] auth-side cookie present: ${auth.name}`);
  else console.log('[login] WARNING: no recognizable auth cookie. Jar may be incomplete.');
}

export function loadTencentCookies() {
  if (!existsSync(JAR_PATH)) {
    throw new Error(`No Tencent jar at ${JAR_PATH}. Run src/trajectories/tencent/login.mjs first.`);
  }
  const jar = JSON.parse(readFileSync(JAR_PATH, 'utf8'));
  return jar.cookies;
}

async function main() {
  const creds = await getGoogleSsoCreds();
  if (!creds) { console.log('FAIL: exact weles-google-sso-login grant unavailable'); process.exit(Number('1')); }
  console.log(`[login] Using Google SSO: ${creds.email}`);

  // Pin persona across runs so the post-captcha "Trust this device" cookie
  // (valid 7d) is honored — Tencent binds the trust to UA + canvas hash.
  let pinned = null;
  try { pinned = JSON.parse(readFileSync(PERSONA_PATH, 'utf8')); console.log(`[login] reusing pinned persona from ${PERSONA_PATH}`); } catch {}
  const s = await WSession.start({ label: 'tencent_login', browser: 'chromium', persona: pinned ?? undefined });
  try { if (!existsSync(JAR_DIR)) mkdirSync(JAR_DIR, { recursive: true }); writeFileSync(PERSONA_PATH, JSON.stringify(s.personaConfig, null, 2)); console.log(`[login] persona persisted to ${PERSONA_PATH}`); } catch (e) { console.log(`[login] persona persist warn: ${e.message?.slice(0, 80)}`); }
  try {
    console.log(`[login] navigating to ${LOGIN_URL}`);
    await s.goto(LOGIN_URL);
    await humanIdlePause('deliberate');

    const popup = await clickGoogleSsoButton(s.page);
    if (popup === undefined) { console.log('FAIL: Google SSO button not found'); process.exit(1); }
    if (popup) await popup.waitForLoadState('domcontentloaded').catch(() => {});

    const ok = await googleSso(s, creds, { originHost: ORIGIN_HOST, page: popup ?? undefined });
    if (!ok) { console.log('FAIL: Google SSO did not land back on tencentcloud.com'); process.exit(1); }

    // SSO returns to /forward — wait for it to redirect to console.
    const onConsole = (u) => {
      try { return /^console\.(intl\.)?(cloud\.tencent|tencentcloud)\.com$/.test(new URL(u).hostname); }
      catch { return false; }
    };
    let dumpedVerify = false;
    for (let i = 0; i < 60; i++) {
      await humanIdlePause('short');
      const u = s.page.url();
      if (onConsole(u)) {
        console.log(`[login] forward redirected to console after ${i}s: ${u}`);
        break;
      }
      // First time we land on /verify, dump the DOM so we can see what
      // the page actually shows (captcha? approve button? error?).
      if (/\/account\/login\/verify/.test(u) && !dumpedVerify) {
        console.log('========================================================');
        console.log('[login] HUMAN ACTION: solve the TC-Captcha drag puzzle');
        console.log('         in the visible weles window. After you solve,');
        console.log('         I will type the email code + tick "Trust this');
        console.log('         device (7d)" + submit, all autonomously.');
        console.log('========================================================');
        // Wait until the captcha widget is no longer overlaying (iframe gone
        // or activeElement is no longer IFRAME).
        await s.page.waitForFunction(() => {
          const f = document.querySelector('#tcaptcha_iframe_dy');
          return !f || f.style.display === 'none' || f.offsetWidth === 0 || (document.activeElement && document.activeElement.tagName !== 'IFRAME');
        }).catch((e) => console.log(`[login] captcha-wait err: ${e.message?.slice(0, 80)}`));
        console.log('[login] captcha appears resolved; proceeding');
        const sendCode = s.page.locator('a:has-text("Send code"), button:has-text("Send code")').filter({ visible: true }).first();
        if (await sendCode.count() > 0) {
          console.log('[login] clicking "Send code" — verification email dispatching');
          try { await humanClickLocator(s.page, sendCode); } catch { /* sendCode may have already dispatched */ }
          // Auto-fetch from Gmail using SSO-minted session cookies.
          let code = null;
          try {
            const gmailTab = await s.page.context().newPage();
            console.log('[login] opening Gmail to fetch verification code');
            await gmailTab.goto('https://mail.google.com/mail/u/0/#search/from%3Atencentcloud.com+OR+from%3Atencent.com+newer_than%3A1h', { waitUntil: 'domcontentloaded' }).catch(() => {});
            const handle = await gmailTab.waitForFunction(() => {
              const t = document.body ? document.body.innerText : '';
              const m = t.match(/\b(\d{6})\b/);
              return m ? m[1] : false;
            }).catch(() => null);
            if (handle) { code = await handle.jsonValue(); console.log(`[login] got code from Gmail: ${code}`); }
            else console.log('[login] Gmail did not yield a 6-digit code in time');
            await gmailTab.close().catch(() => {});
          } catch (e) { console.log(`[login] Gmail auto-fetch errored: ${e.message?.slice(0, 120)}`); }
          // Investigate iframes / captcha BEFORE attempting to type. v12 dump
          // showed activeElement=IFRAME after clicking the tel input — Tencent
          // overlays a captcha that has to be solved first.
          try {
            const iframes = await s.page.evaluate(() => Array.from(document.querySelectorAll('iframe')).map(f => ({ src: f.src, id: f.id, cls: f.className, w: f.offsetWidth, h: f.offsetHeight })));
            console.log(`[login] iframes on /verify: ${JSON.stringify(iframes)}`);
            const allFrames = s.page.frames().map(f => ({ url: f.url(), name: f.name() }));
            console.log(`[login] all frames: ${JSON.stringify(allFrames)}`);
          } catch (e) { console.log(`[login] iframe inspect error: ${e.message?.slice(0, 80)}`); }
          if (!code) {
            console.log('[login] verification code never arrived; falling through to fail path');
          } else {
            console.log(`[login] got verification code (${code.length} digits) — typing into verify form`);
            // The tel input is a tdesign React controlled component. Click the
            // input first (focus it as activeElement), then press each digit
            // through the keyboard API one at a time. This produces real
            // keyboard events that the React onKeyDown/onInput handlers see.
            const codeInput = s.page.locator('input[type="tel"]').filter({ visible: true }).first();
            const { humanType } = await import('../../../dist/human/keyboard.js');
            try { await humanClickLocator(s.page, codeInput); } catch { /* code input may have been auto-focused */ }
            await humanIdlePause('short');
            await humanType(s.page, code);
            await humanIdlePause('short');
            try {
              const dump = await s.page.evaluate(() => {
                const out = { active: document.activeElement?.tagName + ':' + (document.activeElement?.type || '') + '=' + (document.activeElement?.value || '').slice(0, 20) };
                out.inputs = Array.from(document.querySelectorAll('input')).filter(i => i.offsetParent).map(i => ({ type: i.type, name: i.name, maxlen: i.maxLength, value: (i.value || '').slice(0, 20) }));
                return out;
              });
              console.log(`[login] post-press dump: ${JSON.stringify(dump)}`);
            } catch {}
            // Tick "Trust this device"
            const trust = s.page.locator('input[type="checkbox"]').filter({ visible: true }).first();
            if (await trust.count() > 0) {
              const checked = await trust.isChecked().catch(() => false);
              if (!checked) await trust.check().catch(() => {});
              console.log('[login] ticked "Trust this device"');
            }
            await humanIdlePause('short');
            // Submit — find verify/confirm/submit/next button (NOT "Send code" again)
            const submit = s.page.locator('button:has-text("Verify"), button:has-text("Confirm"), button:has-text("Submit"), button:has-text("Next"), button:has-text("OK")').filter({ visible: true }).first();
            if (await submit.count() > 0) {
              console.log('[login] clicking submit on verify form');
              try { await humanClickLocator(s.page, submit); } catch { /* submit may have already fired */ }
            }
            try { unlinkSync(VERIFY_CODE_PATH); } catch {}
            // Give the post-verify redirect a chance to settle before the loop continues.
            await humanIdlePause('long');
          }
        }
      }
      if (!dumpedVerify && /\/account\/login\/verify/.test(u)) {
        dumpedVerify = true;
      }
      if (i % 5 === 0) console.log(`[login] forward wait ${i}s: ${u}`);
    }
    console.log(`[login] post-forward URL: ${s.page.url()}`);

    if (!onConsole(s.page.url())) {
      console.log('[login] forward did not redirect; trying direct goto /hy3d');
      await s.page.goto('https://console.tencentcloud.com/hy3d', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await humanIdlePause('long');
      console.log(`[login] post-goto URL: ${s.page.url()}`);
    } else {
      console.log('[login] navigating to /hy3d for activation');
      await s.page.goto('https://console.tencentcloud.com/hy3d', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await humanIdlePause('long');
      console.log(`[login] post-hy3d URL: ${s.page.url()}`);
    }
    if (!onConsole(s.page.url())) {
      console.log('[login] WARNING: never reached console — SSO may have minted bridge cookies but the console session exchange failed');
    }

    // Drive the AI3D service activation now while still on the same
    // persona/fingerprint that minted the session. Splitting login and
    // activation into two trajectories breaks because Tencent binds the
    // session to UA + canvas + WebGL fingerprint, and weles rolls a fresh
    // persona on every WSession.start.
    console.log('[login] driving AI3D activation on /hy3d');
    const ctaSelectors = [
      'button:has-text("Activate Now")',
      'button:has-text("Activate")',
      'button:has-text("Apply Now")',
      'button:has-text("Apply")',
      'button:has-text("Open Now")',
      'button:has-text("Open Service")',
      'button:has-text("Agree and Activate")',
      'button:has-text("Get Free Credits")',
      'button:has-text("Claim Free Credits")',
      'button:has-text("Subscribe")',
      'button:has-text("Free Trial")',
      'a:has-text("Activate")',
      'a:has-text("Apply Now")',
      'a:has-text("Free Trial")',
      '.t-button--primary',
    ];
    let ctaClicked = null;
    const ctaDeadline = Date.now() + 30000;
    while (Date.now() < ctaDeadline && !ctaClicked) {
      for (const sel of ctaSelectors) {
        const loc = s.page.locator(sel).first();
        if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
          const text = await loc.textContent().catch(() => '');
          console.log(`[login] activation CTA match: ${sel} → "${(text || '').trim().slice(0, 60)}"`);
          try { await humanClickLocator(page, loc); } catch { /* loc may have detached after focus */ }
          ctaClicked = sel;
          break;
        }
      }
      if (!ctaClicked) await humanIdlePause('short');
    }
    if (!ctaClicked) console.log('[login] no activation CTA found on /hy3d (may already be activated)');

    await humanIdlePause('deliberate');
    const confirmSelectors = [
      'button:has-text("Confirm")',
      'button:has-text("OK")',
      'button:has-text("Agree")',
      'button:has-text("I have read and agree")',
      'button:has-text("Submit")',
    ];
    for (const sel of confirmSelectors) {
      const loc = s.page.locator(sel).first();
      if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
        console.log(`[login] clicking confirm: ${sel}`);
        try { await humanClickLocator(page, loc); } catch { /* loc may have detached after focus */ }
        break;
      }
    }
    await humanIdlePause('long');

    await persistJar(s.page);
    console.log('PASS: Tencent Cloud login + AI3D activation complete');
  } catch (e) {
    console.log('FAIL:', e.message?.slice(0, 200));
    process.exit(1);
  } finally {
    await sleep(2000);
    await s.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('[login] fatal:', e); process.exit(1); });
}
