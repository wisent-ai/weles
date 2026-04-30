import { getSocialAccount } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';

const URL = 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.youtube.com%2F';

const acct = await getSocialAccount('youtube');
if (!acct) { console.log('FAIL: no active youtube account in DB'); process.exit(1); }
process.env.SVC_EMAIL = acct.metadata.email ?? acct.username;
process.env.SVC_PASSWORD = acct.metadata.password ?? '';
console.log(`[trajectory] Using account: ${acct.username}`);

const s = await WSession.start({ label: 'youtube_login', proxy: process.env.PROXY_URL || undefined });
try {
  // Cookie-first.
  const stored = Array.isArray(acct.metadata?.cookies) ? acct.metadata.cookies : [];
  if (stored.length) {
    await s.ctx.addCookies(stored.filter(c => c?.name && c?.value && (c.domain || c.url)).map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
    await s.page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
    await s.page.waitForTimeout(3500);
    const u = s.page.url();
    if (/youtube\.com/.test(u) && !/accounts\.google\.com/.test(u)) {
      const loggedIn = await s.page.evaluate(() => !!document.querySelector('button[aria-label*="Account menu" i], img#avatar-btn, ytd-topbar-menu-button-renderer button[aria-label*="Account" i]')).catch(() => false);
      if (loggedIn) {
        console.log(`PASS: logged in (cookie-first) — ${u}`);
        process.exit(0);
      }
    }
  }
  await s.goto(URL);
  await s.page.waitForTimeout(3000);
  // Step 1: email → Next.
  const emailIn = s.page.locator('input[type="email"], input#identifierId, input[name="identifier"]').filter({ visible: true }).first();
  await emailIn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, emailIn);
  await humanType(s.page, process.env.SVC_EMAIL);
  await humanClickLocator(s.page, s.page.locator('button:has-text("Next"), #identifierNext button, button[jsname]:has-text("Next")').filter({ visible: true }).first());
  // Step 2: password → Next.
  const pwIn = s.page.locator('input[type="password"], input[name="Passwd"], input[name="password"]').filter({ visible: true }).first();
  await pwIn.waitFor({ state: 'visible', timeout: 20000 });
  await humanClickLocator(s.page, pwIn);
  await humanType(s.page, process.env.SVC_PASSWORD);
  await humanClickLocator(s.page, s.page.locator('button:has-text("Next"), #passwordNext button, button[jsname]:has-text("Next")').filter({ visible: true }).first());
  // Wait until we land on youtube.com (or myaccount.google.com if redirect path differs).
  await s.page.waitForFunction(() => /youtube\.com\/?(?:\?|$)/.test(location.href) || /myaccount\.google\.com/.test(location.href), { timeout: 30000 });
  console.log(`PASS: logged in (${s.page.url()})`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
