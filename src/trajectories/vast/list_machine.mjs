import { launchProfileChrome } from '../../browser/real_chrome.mjs';
import { findProfileByEmail } from '../../../dist/chrome/cookies.js';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readScopedLogin } from '../../_shared/scoped-secrets.mjs';

const VAST_LOGIN = readScopedLogin('vastDashboard');
const EMAIL = VAST_LOGIN.email;
const PRICE_GPU = process.env.PRICE_GPU || '0.80';
const profile = findProfileByEmail(EMAIL);
if (!profile) { console.log('FAIL: no chrome profile'); process.exit(1); }
const scratch = join(tmpdir(), `weles_list_${Date.now()}`);
mkdirSync(scratch, { recursive: true });
cpSync(profile.path, join(scratch, 'Default'), { recursive: true, dereference: false });
try { cpSync(join(homedir(), 'Library/Application Support/Google/Chrome/Local State'), join(scratch, 'Local State')); } catch {}

const CHROMIUM = process.env.CHROMIUM_PATH;
if (!CHROMIUM) { console.log('FAIL: CHROMIUM_PATH'); process.exit(1); }

// The launch lives in the reviewed browser boundary. This flow runs on a copy
// of the operator's real Chrome profile, so the provider keeps treating it as
// the returning visitor it already trusts.
const ctx = await launchProfileChrome({
  userDataDir: scratch,
  executablePath: CHROMIUM,
  viewport: { width: 1920, height: 1080 },
  args: [],
  ignoreDefaultArgs: [],
  channel: null,
});
const page = ctx.pages()[0] ?? await ctx.newPage();
const wait = (s) => new Promise(r => setTimeout(r, s * 1000));  // allow-raw-playwright: utility sleep shim — usages should migrate to humanIdlePause

try {
  await page.goto('https://cloud.vast.ai/', { waitUntil: 'domcontentloaded' });
  await wait(2);

  // Always attempt login — unreliable to detect from DOM, cheap to retry.
  {
    const popupP = ctx.waitForEvent('page').catch(() => null);
    // Sign-in button: Playwright locator.click routes through CDP with isTrusted=true.
    await page.locator('a, button, [role="button"]').filter({ hasText: /^(sign\s*in|log\s*in|login)$/i }).first().click().catch(() => {});
    await wait(3);
    // "Continue with Google" — constrained to short buttons so we don't hit marketing copy.
    await page.locator('a, button, [role="button"], div').filter({ hasText: /google/i }).filter({ hasText: /continue|with google/i }).first().click().catch(() => {});
    const popup = await popupP;
    if (popup) {
      try { await popup.waitForLoadState('domcontentloaded'); } catch {}
      for (let i = 0; i < 60; i++) {
        if (popup.isClosed?.()) break;
        const pu = popup.url();
        let path = '';
        try { path = new URL(pu).pathname; } catch {}
        if (path.includes('/signin/identifier')) {
          try { await popup.fill('input[type="email"]', EMAIL); await popup.click('#identifierNext, button:has-text("Next")').catch(() => {}); } catch {}
        } else if (path.includes('/challenge/pwd') || path.includes('/challenge/password')) {
          const pw = VAST_LOGIN.password;
          try { await popup.fill('input[type="password"]', pw); await popup.click('#passwordNext, button:has-text("Next")').catch(() => {}); } catch {}
        } else if (path.includes('/signin/oauth/') || path.includes('/oauthconsent')) {
          await popup.locator('button, [role="button"], a').filter({ hasText: /^(continue|allow|confirm)$/i }).first().click().catch(() => {});
        }
        await wait(1);
      }
    }
  }

  await page.evaluate(`(async () => {
    var r = await fetch('/api/v0/auth/apikeys/', { credentials: 'include' });
    var keys = await r.json();
    var team = (keys.apikeys || []).find(k => k.key_type === 'team' && k.team_name === 'Wisent');
    if (team) {
      await fetch('/api/v0/users/save-context/', {
        method: 'PUT', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ context_key_id: team.id }),
      });
    }
  })()`);

  await page.goto('https://cloud.vast.ai/host/machines/', { waitUntil: 'domcontentloaded' });
  await wait(7);

  const uiTrace = [];
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('vast.ai/api') && !u.includes('csp-reports') && req.method() !== 'GET') {
      uiTrace.push(`${req.method()} ${u.slice(0, 140)} ${(req.postData() || '').slice(0, 200)}`);
    }
  });

  const settingsLoc = page.locator('button, [role="button"]').filter({ hasText: /^SETTINGS$/ });
  const clicked = (await settingsLoc.count()) > 0;
  if (clicked) await settingsLoc.first().click().catch(() => {});
  console.log('settings_clicked ->', clicked);
  await wait(3);

  // Fill the first empty input inside the dialog. On-Demand Price is the
  // first price field rendered.
  const filled = await page.evaluate((p) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const dialog = Array.from(document.querySelectorAll('[role="dialog"], [class*="odal"], [class*="ialog"]'))
      .find(el => el.offsetParent !== null) || document.body;
    const inputs = Array.from(dialog.querySelectorAll('input'))
      .filter(el => el.offsetParent !== null);
    const first = inputs.find(el => !el.value && (el.type === 'number' || el.type === 'text' || !el.type));
    if (first) {
      setter.call(first, p);
      first.dispatchEvent(new Event('input', { bubbles: true }));
      first.dispatchEvent(new Event('change', { bubbles: true }));
      first.blur();
      return { filled: true, label: first.placeholder || first.name || 'unknown' };
    }
    return { filled: false, inputs_count: inputs.length };
  }, PRICE_GPU);
  console.log('fill_price ->', JSON.stringify(filled));
  await wait(2);
  const listLoc = page.locator('[role="dialog"] button, [class*="odal"] button, [class*="ialog"] button').filter({ hasText: /^LIST$/ }).first();
  const list_exists = (await listLoc.count()) > 0;
  const list_disabled = list_exists ? await listLoc.isDisabled().catch(() => null) : null;
  let clicked_list = false;
  if (list_exists && list_disabled === false) { await listLoc.click().catch(() => {}); clicked_list = true; }
  const result = { list_exists, list_disabled, clicked_list };
  console.log('list_click ->', JSON.stringify(result));
  await wait(5);
  const toast = await page.evaluate(() => {
    const m = (document.body?.innerText || '').match(/[^\n]*(listed|success|error|fail|invalid)[^\n]*/i);
    return m ? m[0].slice(0, 200) : null;
  });
  console.log('toast ->', toast);
  for (const t of uiTrace.slice(0, 20)) console.log('net:', t);

  await page.screenshot({ path: '/tmp/vast_list_result.png', fullPage: true }).catch(() => {});
  console.log('screenshot -> /tmp/vast_list_result.png');
  process.exit(0);
} catch (e) {
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  process.exit(1);
} finally {
  await ctx.close().catch(() => {});
  try { rmSync(scratch, { recursive: true, force: true }); } catch {}
}
