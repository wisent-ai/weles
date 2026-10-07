/**
 * Reddit signup with direct Playwright steps (no LLM agent loop). Flow:
 *   1. /register → fill email → Continue
 *   2. checkEmail polls for 6-digit verification code → fill code → Continue
 *   3. Fill username + password → Sign Up
 *   4. Persist to Skarbiec with cookies (saveAccount)
 *   5. Verify the Skarbiec record and reddit_session cookie before printing PASS
 */
import { WSession } from '../../../dist/session/wsession.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { humanMove, humanClickLocator } from '../../../dist/human/mouse.js';
import { pageSettled } from '../_shared/page/settled.mjs';
import { autoBindCharacter } from '../lib/character-bind.mjs';
import { findAccount } from '../_shared/skarbiec/accounts.mjs';

const URL = 'https://www.reddit.com/register';

// PacketStream's residential range gets accounts insta-shadowbanned by
// Reddit (account creates fine, then 404s within 60s). Force a non-
// PacketStream provider when picking the proxy. Specific provider in
// the filter triggers config.ts's KNOWN_PROVIDERS match — only providers
// matching that name will be tried.
const PROXY_FILTER = process.env.PROXY_URL || 'residential oxylabs us';
// Persona + identity rotation centralized in WSession.start (opts.platform).
const s = await WSession.start({
  label: 'reddit_register',
  proxy: PROXY_FILTER,
  targetHost: 'www.reddit.com',
  platform: 'reddit',
});
const id = {
  first: s.identity.firstName,
  last: s.identity.lastName,
  username: s.identity.username,
  email: s.identity.email,
  password: s.identity.password,
  name: `${s.identity.firstName} ${s.identity.lastName}`,
};
console.log(`[register] identity: ${id.username} ${id.email}`);
// Use shared atomic helpers from src/human/. Empirical-distribution timing
// (p50=105ms keystroke dwell, p50=169ms inter-key, Bezier mouse paths) derived
// from real operator behavior trace. Reddit's signup-time bot classifier is
// active since ~March 2026 — evidenced by 0/9 April fleet signups surviving vs
// 4/16 Feb signups surviving — and reads the behavior trace, not just
// fingerprint surface.
async function vpJitter() {
  const vp = s.page.viewportSize();
  if (!vp) return;
  await humanMove(
    s.page,
    100 + Math.floor(Math.random() * (vp.width - 200)),
    100 + Math.floor(Math.random() * (vp.height - 200)),
  );
}

// Capture reddit's email-verify-initialize response. A 403 here with
// recaptcha_token=INVALID means reddit's reCAPTCHA Enterprise scored the token
// below threshold (driven by exit-IP reputation, not the browser) and never
// dispatched the code — surfaced to the user as "Something went wrong sending
// verification code." We catch it explicitly so the log shows the real cause
// instead of a generic email-poll timeout.
let verifyInit = null;
s.page.on('response', async (resp) => {
  if (!/register_email_verify_initialize/i.test(resp.url())) return;
  const status = resp.status();
  let body = '';
  try {
    body = await resp.text();
  } catch {
    /* body may be unavailable */
  }
  let reason = '',
    recaptcha = '';
  try {
    const j = JSON.parse(body);
    reason = j?.error?.message || '';
    recaptcha = j?.error?.params?.recaptcha_token || '';
  } catch {
    /* non-JSON body */
  }
  verifyInit = { status, ok: resp.ok(), reason, recaptcha, body: body };
  if (resp.ok()) {
    console.log(
      `[verify-init] OK status=${status} — reddit dispatched the code`,
    );
  } else {
    console.log(
      `FAIL: verify_init_rejected status=${status} recaptcha_token=${recaptcha || 'n/a'} reason="${reason}" body=${verifyInit.body}`,
    );
  }
});

try {
  await s.page.goto(URL, { waitUntil: 'domcontentloaded' });
  await pageSettled(s.page);
  await vpJitter();

  // Step 1: email
  const emailIn = s.page
    .locator(
      'input[type="email"], input[name="email"], input[autocomplete="email"]',
    )
    .filter({ visible: true })
    .first();
  await emailIn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, emailIn);
  await pageSettled(s.page);
  await humanType(s.page, id.email);
  await pageSettled(s.page);
  await vpJitter();
  const continueBtn = s.page
    .getByRole('button', { name: /continue/i })
    .filter({ visible: true })
    .first();
  await humanClickLocator(s.page, continueBtn);
  console.log('[register] submitted email');

  // Step 2: wait for verification code page, fetch code, fill it
  await pageSettled(s.page);
  // If verify-init already came back rejected, fail fast with the real reason
  // (no code will ever arrive) rather than burning the full email-poll timeout.
  if (verifyInit && !verifyInit.ok) {
    throw new Error(
      `verify_init_rejected: status=${verifyInit.status} recaptcha_token=${verifyInit.recaptcha || 'n/a'} reason="${verifyInit.reason}"`,
    );
  }
  const code = await s.checkEmail(id.email, 'reddit');
  if (/^error|^no (code|email)/.test(code)) {
    const detail =
      verifyInit && !verifyInit.ok
        ? ` (verify_init status=${verifyInit.status} recaptcha_token=${verifyInit.recaptcha})`
        : '';
    throw new Error(`email_code_failed: ${code}${detail}`);
  }
  console.log(`[register] got verification code: ${code}`);
  await pageSettled(s.page);
  await vpJitter();
  const codeIn = s.page
    .locator(
      'input[autocomplete="one-time-code"], input[name="code"], input[type="text"][maxlength="6"]',
    )
    .filter({ visible: true })
    .first();
  await codeIn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, codeIn);
  await pageSettled(s.page);
  await humanType(s.page, code);
  await pageSettled(s.page);
  await humanClickLocator(
    s.page,
    s.page
      .getByRole('button', { name: /continue|verify|submit/i })
      .filter({ visible: true })
      .first(),
  );
  console.log('[register] submitted code');

  // Step 3: username + password
  await pageSettled(s.page);
  await vpJitter();
  const userIn = s.page
    .locator('input[name="username"], input[autocomplete="username"]')
    .filter({ visible: true })
    .first();
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
  const beforeVal = await userIn.inputValue().catch(() => '');
  if (beforeVal)
    console.log(
      `[register] clearing auto-suggested username "${beforeVal}" before typing chosen "${id.username}"`,
    );
  await humanClickLocator(s.page, userIn);
  // Reddit's React-controlled username field auto-fills a suggestion. The
  // only reliable way to clear React-controlled inputs is Playwright's
  // .fill('') (React-aware setter). humanFill's Ctrl+A+Delete is rejected
  // because React re-injects the suggestion after the keyboard event.
  // After clearing we use humanType for the actual chosen value (real
  // CDP keystrokes — anti-bot clean).
  // React may re-inject its suggestion after the clear; the settled field is
  // what the typing lands in, and a field that still differs is a named failure.
  await userIn.fill(''); // lint-allow: bare-fill
  await pageSettled(s.page);
  await humanType(s.page, id.username);
  const afterVal = await userIn.inputValue();
  console.log(`[register] after typing "${id.username}": "${afterVal}"`);
  if (afterVal !== id.username)
    throw new Error(
      `reddit_username_not_set: field holds "${afterVal}" instead of "${id.username}"`,
    );
  await pageSettled(s.page);
  await vpJitter();
  const pwIn = s.page
    .locator('input[type="password"], input[autocomplete="new-password"]')
    .filter({ visible: true })
    .first();
  await humanClickLocator(s.page, pwIn);
  await pageSettled(s.page);
  await humanType(s.page, id.password);
  await pageSettled(s.page);
  await vpJitter();
  await humanClickLocator(
    s.page,
    s.page
      .getByRole('button', { name: /sign up|continue|create/i })
      .filter({ visible: true })
      .first(),
  );
  console.log('[register] submitted username + password');

  // Step 4: the post-signup redirect (/onboarding, /, etc) has happened once
  // the page has settled.
  await pageSettled(s.page);
  console.log(`[register] post-signup url=${s.page.url()}`);

  // Step 5: persist + verify
  const result = await s.saveAccount('reddit', {
    username: id.username,
    email: id.email,
    password: id.password,
    name: id.name,
  });
  console.log(`[register] saveAccount: ${result}`);
  await autoBindCharacter(id.username, 'reddit')
    .then((r) => console.log(`[bind] ${JSON.stringify(r)}`))
    .catch((e) => console.log(`[bind] err: ${e.message}`));

  const saved = findAccount('reddit', id.username);
  if (!saved) {
    console.log(
      `FAIL: saveAccount returned ok but no Skarbiec item for ${id.username}`,
    );
    process.exitCode = 1;
  } else {
    const cookies = saved.metadata?.cookies ?? [];
    const hasSession = cookies.some?.((c) =>
      /reddit_session|token_v2/.test(c?.name ?? ''),
    );
    if (!hasSession) {
      console.log(
        `FAIL: item ${saved.id} saved but no reddit_session cookie — signup didn't authenticate`,
      );
      process.exitCode = 1;
    } else
      console.log(
        `PASS: ${id.username} (skarbiec_item=${saved.id} cookies=${cookies.length} reddit_session=yes)`,
      );
  }
} catch (e) {
  console.log('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await s.close();
}
