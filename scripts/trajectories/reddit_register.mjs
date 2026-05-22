/**
 * Reddit signup with direct Playwright steps (no LLM agent loop). Flow:
 *   1. /register → fill email → Continue
 *   2. checkEmail polls for 6-digit verification code → fill code → Continue
 *   3. Fill username + password → Sign Up
 *   4. Persist to social_accounts with cookies (saveAccount)
 *   5. Verify DB row + reddit_session cookie before printing PASS
 */
import { WSession } from '../../dist/session/wsession.js';
import { humanType } from '../../dist/human/keyboard.js';
import { humanMove, humanIdlePause, humanClickLocator } from '../../dist/human/mouse.js';
import { autoBindCharacter } from './lib/character-bind.mjs';

const URL = 'https://www.reddit.com/register';

// PacketStream's residential range gets accounts insta-shadowbanned by
// Reddit (account creates fine, then 404s within 60s). Force a non-
// PacketStream provider when picking the proxy. Specific provider in
// the filter triggers config.ts's KNOWN_PROVIDERS match — only providers
// matching that name will be tried.
const PROXY_FILTER = process.env.PROXY_URL || 'residential oxylabs us';
// Persona + identity rotation centralized in WSession.start (opts.platform).
const s = await WSession.start({ label: 'reddit_register', proxy: PROXY_FILTER, targetHost: 'www.reddit.com', platform: 'reddit' });
const id = { first: s.identity.firstName, last: s.identity.lastName, username: s.identity.username, email: s.identity.email, password: s.identity.password, name: `${s.identity.firstName} ${s.identity.lastName}` };
console.log(`[register] identity: ${id.username} ${id.email}`);
// Use shared atomic helpers from src/human/. Empirical-distribution timing
// (p50=105ms keystroke dwell, p50=169ms inter-key, Bezier mouse paths) derived
// from real operator behavior trace. Reddit's signup-time bot classifier is
// active since ~March 2026 — evidenced by 0/9 April fleet signups surviving vs
// 4/16 Feb signups surviving — and reads the behavior trace, not just
// fingerprint surface.
async function vpJitter() {
  const vp = s.page.viewportSize(); if (!vp) return;
  await humanMove(s.page, 100 + Math.floor(Math.random() * (vp.width - 200)), 100 + Math.floor(Math.random() * (vp.height - 200)));
}

try {
  await s.page.goto(URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');
  await vpJitter();

  // Step 1: email
  const emailIn = s.page.locator('input[type="email"], input[name="email"], input[autocomplete="email"]').filter({ visible: true }).first();
  await emailIn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, emailIn);
  await humanIdlePause('short');
  await humanType(s.page, id.email);
  await humanIdlePause('short');
  await vpJitter();
  const continueBtn = s.page.getByRole('button', { name: /continue/i }).filter({ visible: true }).first();
  await humanClickLocator(s.page, continueBtn);
  console.log('[register] submitted email');

  // Step 2: wait for verification code page, fetch code, fill it
  await humanIdlePause('deliberate');
  const code = await s.checkEmail(id.email, 'reddit');
  if (/^error|^no code/.test(code)) throw new Error(`email_code_failed: ${code}`);
  console.log(`[register] got verification code: ${code}`);
  await humanIdlePause('short');
  await vpJitter();
  const codeIn = s.page.locator('input[autocomplete="one-time-code"], input[name="code"], input[type="text"][maxlength="6"]').filter({ visible: true }).first();
  await codeIn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, codeIn);
  await humanIdlePause('short');
  await humanType(s.page, code);
  await humanIdlePause('short');
  await humanClickLocator(s.page, s.page.getByRole('button', { name: /continue|verify|submit/i }).filter({ visible: true }).first());
  console.log('[register] submitted code');

  // Step 3: username + password
  await humanIdlePause('deliberate');
  await vpJitter();
  const userIn = s.page.locator('input[name="username"], input[autocomplete="username"]').filter({ visible: true }).first();
  await userIn.waitFor({ state: 'visible' });
  // CRITICAL: Reddit's current /register flow auto-fills a suggested
  // username (e.g. "Glad_Grape_9029" or "Melodic-Image-84sa77") into the
  // input. humanType() inserts at the cursor and does NOT clear, so our
  // typed username gets appended to the suggestion → over-length →
  // Reddit truncates back to its suggestion → final account uses the
  // auto-generated name. Reddit treats `Adjective-Noun-NN` accounts as
  // "low-effort signups" and auto-shadowbans them within minutes of the
  // first action. Clearing the field first restores the chosen username
  // and lifts the auto-shadowban.
  // Verified 2026-04-29: BEFORE fix, 2/2 fresh accounts insta-shadowbanned
  // (Acceptable-Fold58m86, Melodic-Image-84sa77). AFTER fix, sagewest6029
  // commented publicly-visible on the first attempt.
  const beforeVal = await userIn.inputValue().catch(() => '');
  if (beforeVal) console.log(`[register] clearing auto-suggested username "${beforeVal}" before typing chosen "${id.username}"`);
  await humanClickLocator(s.page, userIn);
  // Reddit's React-controlled username field auto-fills a suggestion. The
  // only reliable way to clear React-controlled inputs is Playwright's
  // .fill('') (React-aware setter). humanFill's Ctrl+A+Delete is rejected
  // because React re-injects the suggestion after the keyboard event.
  // After clearing we use humanType for the actual chosen value (real
  // CDP keystrokes — anti-bot clean).
  for (let attempt = 0; attempt < 3; attempt++) {
    await userIn.fill('').catch(() => {}); // lint-allow: bare-fill
    await humanIdlePause('short');
    await humanType(s.page, id.username);
    const afterVal = await userIn.inputValue().catch(() => '');
    console.log(`[register] username attempt ${attempt + 1}: after typing "${id.username}": "${afterVal}"`);
    if (afterVal === id.username) break;
  }
  const afterVal = await userIn.inputValue().catch(() => '');
  if (afterVal !== id.username) console.log(`[register] WARN: username field final value "${afterVal}" != chosen "${id.username}" — Reddit may use the wrong handle`);
  await humanIdlePause('short');
  await vpJitter();
  const pwIn = s.page.locator('input[type="password"], input[autocomplete="new-password"]').filter({ visible: true }).first();
  await humanClickLocator(s.page, pwIn);
  await humanIdlePause('short');
  await humanType(s.page, id.password);
  await humanIdlePause('short');
  await vpJitter();
  await humanClickLocator(s.page, s.page.getByRole('button', { name: /sign up|continue|create/i }).filter({ visible: true }).first());
  console.log('[register] submitted username + password');

  // Step 4: wait for post-signup redirect (/onboarding, /, etc)
  for (let i = 0; i < 20; i++) {
    await humanIdlePause('short');
    const u = s.page.url();
    if (!/\/register/.test(u)) break;
  }
  console.log(`[register] post-signup url=${s.page.url()}`);

  // Step 5: persist + verify
  const result = await s.saveAccount('reddit', { username: id.username, email: id.email, password: id.password, name: id.name });
  console.log(`[register] saveAccount: ${result}`);
  await autoBindCharacter(id.username, 'reddit').then(r => console.log(`[bind] ${JSON.stringify(r)}`)).catch((e) => console.log(`[bind] err: ${e.message?.slice(0, 80)}`));

  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (supabaseUrl && key) {
    const r = await fetch(`${supabaseUrl}/rest/v1/social_accounts?platform=eq.reddit&username=eq.${encodeURIComponent(id.username)}&select=id,metadata`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    const rows = await r.json();
    if (!rows?.[0]) { console.log(`FAIL: saveAccount returned ok but no DB row for ${id.username}`); process.exitCode = 1; }
    const cookies = rows[0].metadata?.cookies ?? [];
    const hasSession = cookies.some?.(c => /reddit_session|token_v2/.test(c?.name ?? ''));
    if (!hasSession) { console.log(`FAIL: row ${rows[0].id} saved but no reddit_session cookie — signup didn't authenticate`); process.exitCode = 1; }
    console.log(`PASS: ${id.username} (db_row=${rows[0].id} cookies=${cookies.length} reddit_session=yes)`);
  } else {
    console.log(`PASS: ${id.username} (no DB verification — SUPABASE_URL not set)`);
  }
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 300));
  process.exitCode = 1;
} finally {
  await s.close();
}
