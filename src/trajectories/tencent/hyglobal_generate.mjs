// Drive 3d.hunyuanglobal.com (Tencent HY 3D Global creator portal) for per-race
// text-to-3D generation. Loads cookies + persona from login.mjs.

import { WSession } from '../../../dist/session/wsession.js';
import { loadTencentCookies } from './login.mjs';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
import { humanFill } from '../../../dist/human/keyboard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERIFY_CODE_PATH = join(homedir(), '.weles', 'tencent_verify_code.txt');
const PORTAL_URL = 'https://3d.hunyuanglobal.com/';
const PERSONA_PATH = join(homedir(), '.weles', 'cookie-jars', 'tencent_persona.json');
const OUT_DIR = join(__dirname, '..', '..', '..', '..', 'simple-rts-unity', 'web', 'art', 'models');

const PROMPTS = {
  humans:    'low-poly stylized fantasy human knight axe warrior, full plate armor, red cape, t-pose, full body, game-ready',
  dwarves:   'low-poly stylized fantasy dwarf warrior, thick beard, heavy bronze armor, axe, broad chunky proportions, t-pose, full body',
  elves:     'low-poly stylized fantasy elf warrior, pointed ears, silver-green armor, spear, slender heroic proportions, t-pose, full body',
  skeletons: 'low-poly stylized fantasy skeleton warrior, bone armor, pale skull, ragged blue cape, scythe, t-pose, full body',
};

async function dumpDOM(s, label) {
  const d = await s.page.evaluate(() => ({
    bodyText: (document.body?.innerText || '').slice(0, 3000),
    buttons: Array.from(document.querySelectorAll('button, a, [role=button]')).filter(e => e.offsetParent).map(e => ({ tag: e.tagName, text: (e.innerText || '').trim().slice(0, 80), href: e.href || '' })).filter(o => o.text).slice(0, 30),
    inputs: Array.from(document.querySelectorAll('input, textarea')).filter(e => e.offsetParent).map(e => ({ tag: e.tagName, type: e.type, name: e.name, placeholder: e.placeholder || '' })).slice(0, 15),
  })).catch((e) => ({ err: e.message }));
  console.log(`[hy] ${label} URL=${s.page.url()}`);
  console.log(`[hy] ${label} DOM:`, JSON.stringify(d, null, 2));
}

async function fetchCodeFromGmail(s, sentAtMs) {
  // Wait long enough for delivery (Gmail can lag 30-60s on Tencent emails)
  await humanIdlePause('long');
  const tab = await s.page.context().newPage();
  console.log(`[hy] opening Gmail (sentAt=${new Date(sentAtMs).toISOString()})`);
  // newer_than:1h is much wider — we'll filter by timestamp on read
  const q = 'subject%3A(Hunyuan+OR+%22HY+3D%22+OR+verification)+newer_than%3A1h';
  await tab.goto(`https://mail.google.com/mail/u/0/#search/${q}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  // Wait for at least one thread row to appear (Gmail finishes loading).
  await tab.locator('[role="main"] tr.zA').first().waitFor({ state: 'visible' }).catch(() => {});
  const firstRow = tab.locator('[role="main"] tr.zA').first();
  if (await firstRow.count().catch(() => 0)) {
    try { await humanClickLocator(tab, firstRow); } catch { /* row may have re-sorted */ }
    // Wait for the thread body to render (expanded message has class .ii.gt or .a3s.aiL)
    await tab.locator('.a3s, .ii').first().waitFor({ state: 'visible' }).catch(() => {});
    await humanIdlePause('deliberate');
  }
  // Pull timestamp from the email header span (Gmail puts a title="Mon, May 8, 2026, 5:40 AM" attribute on the time element)
  const meta = await tab.evaluate(() => {
    const timeSpans = Array.from(document.querySelectorAll('[role="main"] span[title]')).filter(s => /\d{1,2}:\d{2}/.test(s.title));
    const headerTitle = timeSpans[0]?.title || '';
    const text = (document.body?.innerText || '').slice(0, 3500);
    return { headerTitle, text };
  }).catch(() => ({ headerTitle: '', text: '' }));
  console.log(`[hy] gmail email title attr: ${meta.headerTitle}`);
  console.log(`[hy] gmail dump first 1200: ${meta.text.replace(/\n/g, ' | ').slice(0, 1200)}`);
  // Also dump ALL email row dates from the search-results list
  const allRows = await tab.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr.zA, [role="main"] tr'));
    return rows.slice(0, 15).map(r => {
      const t = (r.innerText || '').replace(/\s+/g, ' ').slice(0, 200);
      const dateSpan = r.querySelector('span[title]');
      return { title: dateSpan?.title || '', preview: t };
    });
  }).catch(() => []);
  console.log(`[hy] inbox rows (timestamps): ${JSON.stringify(allRows.slice(0, 10), null, 2)}`);
  const emailMs = meta.headerTitle ? Date.parse(meta.headerTitle) : NaN;
  if (Number.isFinite(emailMs)) {
    console.log(`[hy] email timestamp ${new Date(emailMs).toISOString()} vs sentAt ${new Date(sentAtMs).toISOString()} (delta=${Math.round((emailMs - sentAtMs)/1000)}s)`);
    if (emailMs < sentAtMs - 60000) {
      console.log('[hy] top email is older than sentAt — code is stale, rejecting');
      await tab.close().catch(() => {});
      return null;
    }
  }
  const m = meta.text.match(/(?:code|verification|verify)[^\d]{0,60}(\d{6})\b/i) || meta.text.match(/\b(\d{6})\b/);
  const code = m ? m[1] : null;
  await tab.close().catch(() => {});
  return code;
}

async function ensureGoogleSession(s) {
  const creds = await getGoogleSsoCreds();
  if (!creds) { console.log('[hy] no Google SSO creds; skipping Google session bootstrap'); return false; }
  console.log('[hy] bootstrapping Google session in sibling tab so main tab stays free');
  const tab = await s.page.context().newPage();
  await tab.goto('https://accounts.google.com/signin/v2/identifier', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await humanIdlePause('deliberate');
  // Drive googleSso against the sibling tab (pass page: tab to override session.page)
  const ok = await googleSso(s, creds, { originHost: 'google.com', page: tab });
  console.log(`[hy] Google SSO outcome: ${ok}`);
  await tab.close().catch(() => {});
  return ok;
}

async function landAndLogin(s) {
  // Pre-bootstrap the Google session in this context so the Gmail-tab
  // code-fetch later works without a sign-in interstitial.
  await ensureGoogleSession(s);

  console.log(`[hy] navigating to ${PORTAL_URL}`);
  await s.page.goto(PORTAL_URL, { waitUntil: 'commit' }).catch((e) => console.log(`[hy] goto warn: ${e.message?.slice(0, 80)}`));
  // Wait for the SPA to actually render any content (default wait is too short
  // when the page is cached / network is slow).
  await s.page.locator('button:has-text("Start Using"), input[placeholder*="email" i]').first().waitFor({ state: 'visible' }).catch(() => {});
  await humanIdlePause('deliberate');
  await dumpDOM(s, 'pre-login');

  const startBtn = s.page.locator('button:has-text("Start Using"), a:has-text("Start Using")').filter({ visible: true }).first();
  if (await startBtn.count() > 0) {
    console.log('[hy] clicking Start Using');
    try { await humanClickLocator(s.page, startBtn); } catch { /* SPA may have already loaded login form */ }
    // Wait for the email-login form to render
    await s.page.locator('input[placeholder*="email" i]').first().waitFor({ state: 'visible' }).catch(() => {});
    await humanIdlePause('deliberate');
  }
  await dumpDOM(s, 'post-entry');

  // Email-only login: type email, tick ToS, click Continue
  const emailInput = s.page.locator('input[type="text"], input[type="email"]').filter({ visible: true }).first();
  if (await emailInput.count() === 0) { console.log('[hy] no email input — login UI changed?'); return false; }
  console.log('[hy] typing email (wisent.ai — bypasses gmail.com rate limit; readable via Gmail MCP)');
  try { await humanFill(s.page, emailInput, 'lukasz.bartoszcze@wisent.ai'); } catch { /* email may have been pre-filled */ }
  const tos = s.page.locator('input[type="checkbox"]').filter({ visible: true }).first();
  if (await tos.count() > 0) {
    if (!(await tos.isChecked().catch(() => false))) await tos.check().catch(() => {});
    console.log('[hy] ToS checkbox ticked');
  }
  const continueBtn = s.page.locator('button:has-text("Continue"), button:has-text("Next"), button:has-text("Submit"), button[type="submit"]').filter({ visible: true }).first();
  if (await continueBtn.count() > 0) { try { await humanClickLocator(s.page, continueBtn); console.log('[hy] clicked Continue'); } catch { console.log('[hy] continue button vanished before click'); } }
  await humanIdlePause('long');
  await dumpDOM(s, 'post-continue');

  // Click "Send" to dispatch the verification email. tdesign renders this
  // as a span/div inside the code input's suffix slot, not a <button>.
  const sendInfo = await s.page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('*')).filter(e => e.offsetParent && (e.innerText || e.textContent || '').trim() === 'Send' && (e.children.length === 0 || e.children.length === 1));
    return all.slice(0, 5).map(e => ({ tag: e.tagName, cls: e.className, parentTag: e.parentElement?.tagName, parentCls: e.parentElement?.className }));
  }).catch(() => []);
  console.log(`[hy] Send-text candidates: ${JSON.stringify(sendInfo)}`);
  const sendBtn = s.page.getByText('Send', { exact: true }).filter({ visible: true }).first();
  if (await sendBtn.count() > 0) { try { await humanClickLocator(s.page, sendBtn); console.log('[hy] clicked Send'); } catch { console.log('[hy] send button vanished before click'); } }
  else console.log('[hy] no Send element matched by getByText');
  await humanIdlePause('deliberate');
  // Send opens a ToS confirmation modal — click "agree".
  const agreeModalBtn = s.page.locator('button:has-text("agree"), button:has-text("Agree")').filter({ visible: true }).first();
  if (await agreeModalBtn.count() > 0) { try { await humanClickLocator(s.page, agreeModalBtn); console.log('[hy] clicked ToS modal "agree"'); } catch { console.log('[hy] agree modal vanished before click'); } }
  else console.log('[hy] no ToS modal');
  await humanIdlePause('deliberate');
  // Tencent then shows a slide-puzzle captcha modal ("Slide to complete the puzzle").
  // Same pattern as login.mjs v19: user solves once in the visible window, the
  // modal closes, the Send-email API call fires, the email arrives.
  const captchaPresent = await s.page.locator('iframe[id*="tcaptcha"], iframe[src*="captchacdn.tencentcloudcs"]').first().count().catch(() => 0);
  if (captchaPresent > 0) {
    console.log('========================================================');
    console.log('[hy] HUMAN ACTION: solve the slide-puzzle captcha in the');
    console.log('     visible weles window. Trajectory waits for it to close.');
    console.log('========================================================');
    await s.page.waitForFunction(() => {
      const f = document.querySelector('iframe[id*="tcaptcha"], iframe[src*="captchacdn.tencentcloudcs"]');
      return !f || f.style.display === 'none' || f.offsetWidth === 0;
    }).catch((e) => console.log(`[hy] captcha-wait err: ${e.message?.slice(0, 80)}`));
    console.log('[hy] captcha modal closed; email should be dispatching');
  }
  await humanIdlePause('deliberate');
  // Dump page state after Send to detect rate-limit / captcha / error toast
  try {
    const postSend = await s.page.evaluate(() => {
      const txt = (document.body?.innerText || '').slice(0, 2000);
      const toasts = Array.from(document.querySelectorAll('.t-message, [class*="toast" i], [class*="error" i], [class*="alert" i], [role="alert"]')).map(e => (e.innerText || '').trim()).filter(t => t).slice(0, 10);
      const iframes = Array.from(document.querySelectorAll('iframe')).map(f => ({ src: f.src, w: f.offsetWidth, h: f.offsetHeight }));
      return { txt, toasts, iframes };
    });
    console.log(`[hy] post-Send toasts: ${JSON.stringify(postSend.toasts)}`);
    console.log(`[hy] post-Send iframes: ${JSON.stringify(postSend.iframes)}`);
    console.log(`[hy] post-Send body first 800: ${postSend.txt.replace(/\n/g, ' | ').slice(0, 800)}`);
  } catch {}

  const sentAt = Date.now();
  console.log(`[hy] awaiting code at ${VERIFY_CODE_PATH} (Claude reads wisent.ai inbox via Gmail MCP and writes the file)`);
  try { unlinkSync(VERIFY_CODE_PATH); } catch {}
  // Poll the file via recursive promise. Claude side writes it after Gmail MCP fetch.
  async function readFileCode(attempts) {
    if (attempts <= 0) return null;
    await humanIdlePause('deliberate');
    try {
      const raw = readFileSync(VERIFY_CODE_PATH, 'utf8').trim();
      if (raw && /^\d{4,8}$/.test(raw)) return raw;
    } catch {}
    return readFileCode(attempts - 1);
  }
  const code = await readFileCode(60);
  if (code) console.log(`[hy] got code from file: ${code}`);
  if (!code) { console.log('[hy] no verification code in Gmail'); return false; }
  console.log(`[hy] got code ${code}`);
  // Type the code via native value setter for any framework's controlled inputs
  await s.page.evaluate((c) => {
    const inputs = Array.from(document.querySelectorAll('input')).filter(i => i.offsetParent && i.type !== 'checkbox');
    if (inputs.length === 1) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inputs[0], c);
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
    } else if (inputs.length >= 6) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      for (let i = 0; i < Math.min(c.length, inputs.length); i++) {
        setter.call(inputs[i], c[i]);
        inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  }, code).catch(() => {});
  await humanIdlePause('deliberate');
  // Page-2 has its OWN ToS checkbox (separate from Page-1) that must be
  // ticked for "Move in" to enable. Frame 040 of recording confirmed un-ticked.
  const page2Tos = s.page.locator('input[type="checkbox"]').filter({ visible: true }).first();
  if (await page2Tos.count() > 0) {
    const checked = await page2Tos.isChecked().catch(() => false);
    if (!checked) { await page2Tos.check().catch(() => {}); console.log('[hy] Page-2 ToS checkbox ticked'); }
  }
  await humanIdlePause('short');
  const verifyBtn = s.page.locator('button:has-text("Move in"), button:has-text("Verify"), button:has-text("Confirm"), button:has-text("Submit"), button[type="submit"]').filter({ visible: true }).first();
  if (await verifyBtn.count() > 0) { try { await humanClickLocator(s.page, verifyBtn); } catch { /* verify button may be transient */ } }
  await humanIdlePause('deliberate');
  // Tencent shows a "Service Agreement" modal after Move in — confirm with "agree".
  const agreeBtn = s.page.locator('button:has-text("agree"), button:has-text("Agree"), button:has-text("I Agree")').filter({ visible: true }).first();
  if (await agreeBtn.count() > 0) { console.log('[hy] clicking ToS modal "agree"'); try { await humanClickLocator(s.page, agreeBtn); } catch { /* agree button may be transient */ } }
  await humanIdlePause('long');
  await dumpDOM(s, 'post-verify');
  // Strict: must be on the portal with NO /login* in the path.
  const url = s.page.url();
  return /^https?:\/\/3d\.hunyuanglobal\.com\/?$/.test(url) || /^https?:\/\/3d\.hunyuanglobal\.com\/(?!login)/.test(url);
}

async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  let pinned = null;
  try { pinned = JSON.parse(readFileSync(PERSONA_PATH, 'utf8')); console.log('[hy] reusing pinned persona'); } catch {}
  const s = await WSession.start({ label: 'tencent_hyglobal', browser: 'chromium', persona: pinned ?? undefined });
  try {
    let cookies = [];
    try { cookies = loadTencentCookies(); await s.page.context().addCookies(cookies); console.log(`[hy] injected ${cookies.length} cookies`); }
    catch (e) { console.log(`[hy] no jar (run tencent/login.mjs first): ${e.message?.slice(0, 80)}`); }
    const authed = await landAndLogin(s);
    console.log(`[hy] login outcome: ${authed}`);
    await humanIdlePause('deliberate');
  } finally {
    await s.close();
  }
}

main().catch((e) => { console.error('[hy] fatal:', e); process.exit(1); });
