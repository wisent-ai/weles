// One-time trajectory to enable "Device code authorization for Codex" in
// ChatGPT Security Settings. Codex CLI device-auth login cannot complete until
// this toggle is on; the consent page shows a disabled Continue button when it
// is off.
import { getServiceLogin } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { establishGoogleSession, waitForEnabledThenClick } from './google_sso.mjs';
import { humanFill, humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';

const DISPLAY_NAME = process.env.CODEX_DISPLAY_NAME || 'Codex';
const mark = (label) => process.stderr.write(`[enable_device_auth] ${label}\n`);

async function waitForHost(page, hostRe, timeoutSec = 30) {
  for (let i = 0; i < timeoutSec * 10; i += 1) {
    const h = await page.evaluate(() => location.host).catch(() => '');
    if (hostRe.test(h)) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

async function findAndClickSwitch(page, labelRe) {
  // ChatGPT settings render each row as a single button containing the label
  // and a nested switch with role="switch". Click the switch itself, not the
  // label, so the toggle actually changes state.
  const hit = await page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    const all = Array.from(document.querySelectorAll('*'));
    for (const el of all) {
      const txt = (el.innerText || el.textContent || '').trim();
      if (!re.test(txt)) continue;
      // Prefer the smallest matching container so the switch is inside it.
      if (Array.from(el.children).some((c) => re.test((c.innerText || c.textContent || '').trim()))) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const switches = Array.from(el.querySelectorAll('[role="switch"], input[type="checkbox"]'));
      if (switches.length === 0) continue;
      const sw = switches[0];
      const sr = sw.getBoundingClientRect();
      return {
        label: txt.slice(0, 80),
        x: sr.x + sr.width / 2,
        y: sr.y + sr.height / 2,
        docY: sr.y + window.scrollY,
        tag: sw.tagName,
        role: sw.getAttribute('role'),
        ariaChecked: sw.getAttribute('aria-checked'),
        checked: sw.checked,
        disabled: sw.disabled || sw.getAttribute('aria-disabled') === 'true',
      };
    }
    return null;
  }, labelRe.source);
  if (!hit) return false;
  mark(`found switch for /${labelRe.source}/i: ${JSON.stringify(hit)}`);
  if (hit.disabled) throw new Error('toggle is disabled (ChatGPT may require re-auth to change security settings)');
  if (hit.ariaChecked === 'true' || hit.checked === true) {
    mark('switch already enabled');
    return true;
  }
  const { humanClick } = await import('../../../dist/human/mouse.js');
  // Scroll the switch into view so the click lands on a rendered element.
  await page.evaluate((targetY) => {
    const dialog = document.querySelector('div[role="dialog"]');
    const scroller = dialog || window;
    scroller.scrollTo({ top: Math.max(0, targetY - 300), behavior: 'instant' });
  }, hit.docY);
  await page.waitForTimeout(300);
  await humanClick(page, Math.round(hit.x), Math.round(hit.y));
  return true;
}

const login = await getServiceLogin(DISPLAY_NAME);
if (!login) { process.stderr.write(`FAIL: no '${DISPLAY_NAME}' row in service_credentials\n`); process.exit(1); }
if (!login.email || !login.password) {
  process.stderr.write(`FAIL: '${DISPLAY_NAME}' missing email/password\n`);
  process.exit(1);
}

let session;
try {
  process.stderr.write(`[enable_device_auth] enabling for ${login.email}\n`);
  session = await WSession.start({ label: 'codex_enable_device_auth', headless: false, browser: 'chromium' });

  mark('establish_google_session');
  await establishGoogleSession({
    page: session.page,
    login,
    mark,
    humanFill,
    humanClickLocator,
    humanIdlePause,
    humanType,
  });

  mark('goto_chatgpt_login');
  await session.page.goto('https://chatgpt.com/auth/login?auth_type=google', { waitUntil: 'commit' });
  await humanIdlePause('deliberate');
  try { await waitForEnabledThenClick(session.page, /continue with google/i); }
  catch (e) { mark(`no chatgpt continue-with-google button: ${e.message.slice(0, 80)}`); }

  if (!(await waitForHost(session.page, /^chatgpt\.com$/i, 30))) {
    throw new Error(`chatgpt.com login did not complete; current host=${await session.page.evaluate(() => location.host).catch(() => '?')}`);
  }
  mark('chatgpt_logged_in');

  mark('goto_settings_security');
  // Try the Security settings first, then Apps; the Codex device-auth toggle
  // has been seen in both places depending on the account type.
  await session.page.goto('https://chatgpt.com/#settings/security', { waitUntil: 'commit' });
  await humanIdlePause('deliberate');

  const labels = [
    /device code authorization for codex/i,
    /codex.*device/i,
    /device.*codex/i,
  ];

  // The toggle has been observed in the settings DOM even when the General
  // section is shown; do not force-open a specific section. Scroll the main
  // settings panel and look for the toggle.
  let toggled = false;
  await session.page.waitForTimeout(3000);
  for (let scroll = 0; scroll < 16 && !toggled; scroll += 1) {
    for (const re of labels) {
      if (await findAndClickSwitch(session.page, re)) {
        toggled = true;
        break;
      }
    }
    if (!toggled) {
      await session.page.evaluate(() => {
        const dialog = document.querySelector('div[role="dialog"]');
        (dialog || window).scrollBy(0, 600);
      });
      await session.page.waitForTimeout(800);
    }
  }

  if (!toggled) {
    // Fallback 1: try opening Safety explicitly; the toggle may lazy-load there.
    try {
      await waitForEnabledThenClick(session.page, /safety/i);
      await session.page.waitForTimeout(2000);
      for (let scroll = 0; scroll < 10 && !toggled; scroll += 1) {
        for (const re of labels) {
          if (await findAndClickSwitch(session.page, re)) {
            toggled = true;
            break;
          }
        }
        if (!toggled) {
          await session.page.evaluate(() => {
            const dialog = document.querySelector('div[role="dialog"]');
            (dialog || window).scrollBy(0, 600);
          });
          await session.page.waitForTimeout(800);
        }
      }
    } catch (e) {
      mark(`safety fallback skipped: ${e.message.slice(0, 80)}`);
    }
  }

  if (!toggled) {
    // Fallback 2: the toggle may live under Settings > Apps (connected apps).
    try {
      mark('goto_settings_apps');
      await session.page.goto('https://chatgpt.com/#settings/apps', { waitUntil: 'commit' });
      await humanIdlePause('deliberate');
      await session.page.waitForTimeout(3000);
      for (let scroll = 0; scroll < 10 && !toggled; scroll += 1) {
        for (const re of labels) {
          if (await findAndClickSwitch(session.page, re)) {
            toggled = true;
            break;
          }
        }
        if (!toggled) {
          await session.page.evaluate(() => {
            const dialog = document.querySelector('div[role="dialog"]');
            (dialog || window).scrollBy(0, 600);
          });
          await session.page.waitForTimeout(800);
        }
      }
    } catch (e) {
      mark(`apps fallback skipped: ${e.message.slice(0, 80)}`);
    }
  }

  if (!toggled) {
    // Dump the visible text so we can refine the selector.
    const snapshot = await session.page.evaluate(() => ({
      url: location.href,
      text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 10000),
    }));
    throw new Error(`could not locate device-auth toggle. snapshot=${JSON.stringify(snapshot)}`);
  }

  mark('toggle_clicked');
  // Wait a beat for the setting to persist and any confirmation UI to settle.
  await session.page.waitForTimeout(3000);
  process.stderr.write('[enable_device_auth] DONE\n');
} catch (e) {
  process.stderr.write(`FAIL: ${e?.stack || e}\n`);
  process.exitCode = 1;
} finally {
  try { await session?.close(); } catch {}
}
