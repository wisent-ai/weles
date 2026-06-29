// Test login to an existing LinkedIn account through a chosen proxy.
// The account must use Google SSO. Credentials are read from service_credentials
// via the shared google_sso helper (same as balance trajectories).
//
// Usage:
//   LINKEDIN_TEST_PROXY='isp oxylabs us' node --env-file=.env scripts/debug/linkedin_login_test.mjs
//
// Env:
//   LINKEDIN_TEST_PROXY   proxy request string (default: 'isp oxylabs us')
//   AB_HEADLESS=1         run headless (default: false)

import { WSession } from '../../dist/session/wsession.js';
import { generatePersona } from '../../dist/browser/persona.js';
import { googleSso, getGoogleSsoCreds } from '../trajectories/_shared/services/google_sso.mjs';
import { humanClick, humanIdlePause } from '../../dist/human/mouse.js';
import { runRecordingsDir } from '../../dist/session/run-recordings.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const PROXY = process.env.LINKEDIN_TEST_PROXY || 'isp oxylabs us';
const HEADLESS = process.env.AB_HEADLESS === '1';
const NO_CLOSE = process.env.LINKEDIN_TEST_NO_CLOSE === '1';
const PAUSE = process.env.LINKEDIN_TEST_PAUSE === '1';

if (process.env.WELES_INPUT === 'native' && process.env.LINKEDIN_TEST_ALLOW_NATIVE !== '1') {
  console.error('FAIL: native OS input is blocked for this debug script. Set LINKEDIN_TEST_ALLOW_NATIVE=1 only during an observed, isolated run.');
  process.exit(2);
}

async function waitForEnter(msg) {
  const rl = readline.createInterface({ input, output });
  console.log(msg);
  try {
    await rl.question('Naciśnij Enter, aby kontynuować...');
  } finally {
    rl.close();
  }
}

const login = await getGoogleSsoCreds();
if (!login) {
  console.log('FAIL: no Google SSO creds in service_credentials');
  process.exit(1);
}
console.log(`[login-test] Google SSO: ${login.email}`);

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = join(runRecordingsDir('linkedin_login_test'), `run_${ts}`);
mkdirSync(OUT_DIR, { recursive: true });

const persona = generatePersona({ country: 'US', os: 'macos', browser: 'chromium' });
const s = await WSession.start({
  label: 'linkedin_login_test',
  proxy: PROXY,
  targetHost: 'www.linkedin.com',
  platform: 'linkedin',
  os: 'macos',
  browser: 'chromium',
  persona,
  headless: HEADLESS,
  pageDiagnostics: false,
});

const result = {
  proxy: { requested: PROXY, resolved: s.proxyConfig },
  outcome: 'unknown',
  detail: '',
  url: '',
  title: '',
  error: null,
};

function attachDiag(target, label) {
  const log = (kind, data) => console.log(`[diag:${label}] ${kind}: ${JSON.stringify(data).slice(0, 800)}`);
  try {
    target.on('console', msg => log('console', { type: msg.type(), text: msg.text(), location: msg.location() }));
    target.on('pageerror', err => log('pageerror', { message: err?.message, stack: err?.stack?.slice(0, 400) }));
    target.on('request', req => { if (/google|linkedin|gsi/.test(req.url())) log('request', { url: req.url(), method: req.method() }); });
    target.on('response', res => { if (/google|linkedin|gsi/.test(res.url())) log('response', { url: res.url(), status: res.status() }); });
  } catch {}
}
attachDiag(s.page, 'main');
s.page.context().on('page', p => { console.log(`[diag:context] new page ${p.url()}`); attachDiag(p, 'popup'); });

try {
  await s.page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await humanIdlePause('long');

  // Click "Sign in with Google". LinkedIn may render it as a button, a link,
  // or inside a Google GSI iframe.
  await s.page.screenshot({ path: join(OUT_DIR, 'login_page.png'), fullPage: true });
  const loginText = await s.page.evaluate(() => document.body?.innerText || '').catch(() => '');
  writeFileSync(join(OUT_DIR, 'login_page.txt'), loginText);

  if (PAUSE) {
    await waitForEnter(`[login-test] Pauza: okno jest otwarte na ${s.page.url()}. Możesz sprawdzić przycisk Google.`);
  }

  // LinkedIn renders Google SSO inside a Google GSI iframe. Google often injects
  // multiple such iframes (e.g. a zero-height one plus the visible button). Find
  // the visible iframe by bounding box, click its center, and capture the OAuth
  // popup/new page.
  let clicked = false;
  for (let i = 0; i < 3 && !clicked; i++) {
    const frames = s.page.frames()
      .filter(f => /accounts\.google\.com\/gsi\/button/.test(f.url()))
      .map(f => ({ f, el: f.frameElement().catch(() => null) }));
    const resolved = [];
    for (const { f, el } of frames) resolved.push({ f, el: await el });
    const candidates = [];
    for (const { f, el } of resolved) {
      if (!el) continue;
      const box = await el.boundingBox().catch(() => null);
      if (box && box.width >= 20 && box.height >= 20) candidates.push({ f, el, box, area: box.width * box.height });
    }
    candidates.sort((a, b) => b.area - a.area);

    for (const { f, el, box } of candidates) {
      attachDiag(f, `gsi-frame-${i}`);
      try {
        const html = await f.content();
        writeFileSync(join(OUT_DIR, `gsi_frame_${i}.html`), html);
      } catch {}

      await el.scrollIntoViewIfNeeded().catch(() => {});
      const popupPromise = s.page.waitForEvent('popup', { timeout: 3000 }).catch(() => null);
      const pagePromise = s.page.context().waitForEvent('page', { timeout: 3000 }).catch(() => null);

      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      console.log(`[login-test] clicking GSI iframe at ${Math.round(cx)},${Math.round(cy)}`);

      // Click through the shared human atom so WELES_INPUT=native can dispatch
      // a real macOS event into the cross-origin GSI iframe. CDP/frame clicks
      // can open a blank popup without preserving user activation in Weles.
      await humanClick(s.page, cx, cy);

      const oauthSurface = await Promise.race([popupPromise, pagePromise]);
      let oauthPage = oauthSurface && typeof oauthSurface.url === 'function' ? oauthSurface : null;

      if (oauthPage) {
        console.log(`[login-test] OAuth surface opened: ${oauthPage.url()}`);
        for (let j = 0; j < 40; j++) {
          const u = oauthPage.url();
          if (/accounts\.google\.com/.test(u) && !/^about:blank/i.test(u)) break;
          await humanIdlePause('short');
        }
        const ok = await googleSso(s, login, { originHost: 'linkedin.com', page: oauthPage });
        if (!ok) throw new Error('Google SSO flow failed');
        clicked = true;
        break;
      }
      await humanIdlePause('short');
    }
    if (!clicked) await humanIdlePause('short');
  }
  if (!clicked) throw new Error('Google SSO button not found or OAuth surface did not open');

  // Wait for LinkedIn to process the OAuth result.
  await s.page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await humanIdlePause('long');

  const url = s.page.url();
  const title = await s.page.title().catch(() => '');
  const bodyText = await s.page.evaluate(() => document.body?.innerText || '').catch(() => '');
  result.url = url;
  result.title = title;

  if (/feed|m\/feed|onboarding/.test(url)) {
    result.outcome = 'pass';
    result.detail = 'Redirected to feed/logged-in surface.';
  } else if (/checkpoint|challenge|captcha|security-verification|two-step|2-step|verification|pin/.test(url + ' ' + bodyText)) {
    result.outcome = 'challenge';
    result.detail = 'LinkedIn requested verification (checkpoint, captcha, 2FA). Credentials likely correct, but account/flow is flagged.';
  } else if (/login|session_key|session_password|wrong password|incorrect|email or password/.test(url + ' ' + bodyText)) {
    result.outcome = 'rejected';
    result.detail = 'Still on login page or invalid credentials.';
  } else {
    result.outcome = 'unknown';
    result.detail = bodyText.slice(0, 400);
  }

  await s.page.screenshot({ path: join(OUT_DIR, 'final.png'), fullPage: true });
  writeFileSync(join(OUT_DIR, 'result.json'), JSON.stringify(result, null, 2));
  console.log('=== LinkedIn login test ===');
  console.log(`Proxy: ${PROXY}`);
  console.log(`Outcome: ${result.outcome}`);
  console.log(`Detail: ${result.detail}`);
  console.log(`URL: ${result.url}`);
  console.log(`Report: ${OUT_DIR}`);
} catch (e) {
  result.error = String(e?.message ?? e);
  console.log('FAIL:', result.error);
  try { await s.page.screenshot({ path: join(OUT_DIR, 'error.png'), fullPage: true }); } catch {}
  writeFileSync(join(OUT_DIR, 'result.json'), JSON.stringify(result, null, 2));
} finally {
  if (NO_CLOSE || PAUSE) {
    await waitForEnter('[login-test] Sesja zatrzymana. Okno pozostaje otwarte. Naciśnij Enter, aby zamknąć...');
  }
  await s.close();
}
