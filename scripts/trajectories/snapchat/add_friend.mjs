import { getSocialAccount, markCookiesStale } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { assertAuthed, AuthProbeError } from '../_shared/auth-probe.mjs';

const TARGET = process.env.TARGET_USERNAME || 'team.snapchat';
const LOGIN_URL = 'https://accounts.snapchat.com/accounts/login';

const acct = await getSocialAccount('snapchat');
if (!acct) { console.log('FAIL: no active snapchat account in DB'); process.exit(1); }
process.env.SVC_USER = acct.metadata.email ?? acct.username;
process.env.SVC_PASSWORD = acct.metadata.password ?? '';
console.log(`[trajectory] Using account: ${acct.username} target=${TARGET}`);

const s = await WSession.start({ label: 'snapchat_add_friend', proxy: process.env.PROXY_URL || undefined });
try {
  // Cookie-first via stored cookies on accounts.snapchat.com / web.snapchat.com.
  const stored = Array.isArray(acct.metadata?.cookies) ? acct.metadata.cookies : [];
  if (stored.length) await s.ctx.addCookies(stored.filter(c => c?.name && c?.value && (c.domain || c.url)).map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});

  await s.goto('https://web.snapchat.com/');
  await s.page.waitForTimeout(3500);
  if (/login|signup/.test(s.page.url())) {
    // Re-login via accounts.snapchat.com.
    await s.goto(LOGIN_URL);
    await s.page.waitForTimeout(2500);
    const userIn = s.page.locator('input[name="username"], input#username, input[autocomplete="username"], input[type="email"]').filter({ visible: true }).first();
    await humanClickLocator(s.page, userIn);
    await humanType(s.page, process.env.SVC_USER);
    await humanClickLocator(s.page, s.page.locator('button[type="submit"], button:has-text("Next")').filter({ visible: true }).first());
    const pwIn = s.page.locator('input[name="password"], input[type="password"]').filter({ visible: true }).first();
    await pwIn.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, pwIn);
    await humanType(s.page, process.env.SVC_PASSWORD);
    await humanClickLocator(s.page, s.page.locator('button[type="submit"], button:has-text("Log In")').filter({ visible: true }).first());
    await s.page.waitForFunction(() => /accounts\.snapchat\.com\/(?!.*login)|web\.snapchat\.com/.test(location.href), { timeout: 25000 });
    await s.goto('https://web.snapchat.com/');
    await s.page.waitForTimeout(4000);
  }

  // Positive auth probe — see _shared/auth-probe.mjs.
  try { await assertAuthed('snapchat', s, { label: 'snapchat_add_friend' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }

  // web.snapchat.com — use the search/add input. Search box is contenteditable
  // div with role="textbox" / aria-label="Search".
  const searchBox = s.page.locator('div[role="textbox"][contenteditable="true"], input[type="search"], input[aria-label*="Search" i]').filter({ visible: true }).first();
  await searchBox.waitFor({ state: 'visible', timeout: 15000 });
  await humanClickLocator(s.page, searchBox);
  await humanType(s.page, TARGET);
  await s.page.waitForTimeout(2500);
  // First "Add Friend" button in the result list.
  const addBtn = s.page.locator('button:has-text("Add Friend"), button:has-text("Add"), [role="button"]:has-text("Add Friend")').filter({ visible: true }).first();
  await addBtn.waitFor({ state: 'visible', timeout: 10000 });
  await humanClickLocator(s.page, addBtn);
  await s.page.locator('button:has-text("Added"), button:has-text("Pending"), [role="button"]:has-text("Added")').first().waitFor({ state: 'visible', timeout: 10000 });
  console.log(`PASS: added ${TARGET}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
