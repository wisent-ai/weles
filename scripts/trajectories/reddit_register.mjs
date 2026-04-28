/**
 * Reddit signup with direct Playwright steps (no LLM agent loop). Flow:
 *   1. /register → fill email → Continue
 *   2. checkEmail polls for 6-digit verification code → fill code → Continue
 *   3. Fill username + password → Sign Up
 *   4. Persist to social_accounts with cookies (saveAccount)
 *   5. Verify DB row + reddit_session cookie before printing PASS
 */
import { WSession } from '../../dist/session/wsession.js';
import { randomBytes } from 'node:crypto';

const URL = 'https://www.reddit.com/register';
const AGENT_DOMAIN = process.env.AGENT_DOMAIN ?? 'mailwisent.com';

function genIdentity() {
  const F = 'Garry,Katie,Logan,Maya,Owen,Riley,Sage,Tess,Wes,Zane'.split(',');
  const L = 'Koepp,Bayer,Pratt,Quinn,Reeves,Stone,Vega,West,Yates,Cole'.split(',');
  const first = F[Math.floor(Math.random() * F.length)];
  const last = L[Math.floor(Math.random() * L.length)];
  const username = `${first.toLowerCase()}${last.toLowerCase()}${Math.floor(Math.random() * 9000 + 1000)}`;
  const email = `${username}@${AGENT_DOMAIN}`;
  const password = randomBytes(9).toString('base64').replace(/[+/=]/g, '') + '!A1';
  return { first, last, username, email, password, name: `${first} ${last}` };
}

const id = genIdentity();
console.log(`[register] identity: ${id.username} ${id.email}`);

const s = await WSession.start({ label: 'reddit_register', proxy: process.env.PROXY_URL || 'residential', browser: 'chromium' });
try {
  await s.page.goto(URL, { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(3000);

  // Step 1: email
  const emailIn = s.page.locator('input[type="email"], input[name="email"], input[autocomplete="email"]').filter({ visible: true }).first();
  await emailIn.waitFor({ state: 'visible' });
  await emailIn.click();
  await emailIn.pressSequentially(id.email, { delay: 25 });
  await s.page.waitForTimeout(500);
  const continueBtn = s.page.getByRole('button', { name: /continue/i }).filter({ visible: true }).first();
  await continueBtn.click();
  console.log('[register] submitted email');

  // Step 2: wait for verification code page, fetch code, fill it
  await s.page.waitForTimeout(4000);
  const code = await s.checkEmail(id.email, 'reddit');
  if (/^error|^no code/.test(code)) throw new Error(`email_code_failed: ${code}`);
  console.log(`[register] got verification code: ${code}`);
  const codeIn = s.page.locator('input[autocomplete="one-time-code"], input[name="code"], input[type="text"][maxlength="6"]').filter({ visible: true }).first();
  await codeIn.waitFor({ state: 'visible' });
  await codeIn.click();
  await codeIn.pressSequentially(code, { delay: 25 });
  await s.page.waitForTimeout(500);
  await s.page.getByRole('button', { name: /continue|verify|submit/i }).filter({ visible: true }).first().click();
  console.log('[register] submitted code');

  // Step 3: username + password
  await s.page.waitForTimeout(4000);
  const userIn = s.page.locator('input[name="username"], input[autocomplete="username"]').filter({ visible: true }).first();
  await userIn.waitFor({ state: 'visible' });
  await userIn.click();
  await userIn.pressSequentially(id.username, { delay: 25 });
  await s.page.waitForTimeout(500);
  const pwIn = s.page.locator('input[type="password"], input[autocomplete="new-password"]').filter({ visible: true }).first();
  await pwIn.click();
  await pwIn.pressSequentially(id.password, { delay: 25 });
  await s.page.waitForTimeout(500);
  await s.page.getByRole('button', { name: /sign up|continue|create/i }).filter({ visible: true }).first().click();
  console.log('[register] submitted username + password');

  // Step 4: wait for post-signup redirect (/onboarding, /, etc)
  for (let i = 0; i < 20; i++) {
    await s.page.waitForTimeout(1500);
    const u = s.page.url();
    if (!/\/register/.test(u)) break;
  }
  console.log(`[register] post-signup url=${s.page.url()}`);

  // Step 5: persist + verify
  const result = await s.saveAccount('reddit', { username: id.username, email: id.email, password: id.password, name: id.name });
  console.log(`[register] saveAccount: ${result}`);

  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (supabaseUrl && key) {
    const r = await fetch(`${supabaseUrl}/rest/v1/social_accounts?platform=eq.reddit&username=eq.${encodeURIComponent(id.username)}&select=id,metadata`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    const rows = await r.json();
    if (!rows?.[0]) { console.log(`FAIL: saveAccount returned ok but no DB row for ${id.username}`); process.exit(1); }
    const cookies = rows[0].metadata?.cookies ?? [];
    const hasSession = cookies.some?.(c => /reddit_session|token_v2/.test(c?.name ?? ''));
    if (!hasSession) { console.log(`FAIL: row ${rows[0].id} saved but no reddit_session cookie — signup didn't authenticate`); process.exit(1); }
    console.log(`PASS: ${id.username} (db_row=${rows[0].id} cookies=${cookies.length} reddit_session=yes)`);
  } else {
    console.log(`PASS: ${id.username} (no DB verification — SUPABASE_URL not set)`);
  }
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 300));
  process.exit(1);
} finally {
  await s.close();
}
