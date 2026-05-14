/**
 * reddit_register_then_handoff.mjs
 *
 * Registers a fresh Reddit account in the SAME weles WSession (proxy +
 * fingerprint + persona) used by reddit_register_then_comment.mjs, then
 * stops and hands the browser to a human to drive the comment phase by
 * hand. Run with WELES_INSTRUMENT=1 so the property-trap dump captures
 * everything the human does — the human-driven comment phase becomes the
 * chrome reference for the diff against an automated weles run.
 *
 *   WELES_INSTRUMENT=1 SUBREDDIT=CasualConversation \
 *     node --env-file=.env --env-file=../content-platform/.env.local \
 *     scripts/trajectories/reddit_register_then_handoff.mjs
 *
 * On success this script:
 *   1. Registers (email -> code -> username -> password)
 *   2. Saves account row (so the existing weles automation can pick it up
 *      later if you want to compare to an automated comment too)
 *   3. Navigates to the chosen subreddit's homepage
 *   4. Idles forever — Ctrl+C when you've finished posting the comment
 *
 * The instrumentation file at .work/inst/reddit_register_then_handoff_<ts>.json
 * is rewritten every 5s by WSession's instrument loop (src/session/wsession.ts
 * line 137), so even if you Ctrl+C without a clean shutdown you still have a
 * dump containing the comment submission.
 */
import { WSession } from '../../dist/session/wsession.js';
import { humanType } from '../../dist/human/keyboard.js';
import { humanMove, humanIdlePause, humanClickLocator } from '../../dist/human/mouse.js';
import { nativeSelectAllAndDelete } from '../../dist/human/mouse-native.js';

const REGISTER_URL = 'https://www.reddit.com/register';
const NEWBIE_FRIENDLY_SUBS = [
  'CasualConversation', 'AskOldPeople', 'AskReddit', 'NoStupidQuestions',
  'mildlyinteresting', 'todayilearned', 'AskMen', 'AskWomen',
];
const RAW_SUBREDDIT = process.env.SUBREDDIT || 'CasualConversation';
const SUBREDDIT = (RAW_SUBREDDIT === 'popular' || RAW_SUBREDDIT === 'all')
  ? NEWBIE_FRIENDLY_SUBS[Math.floor(Math.random() * NEWBIE_FRIENDLY_SUBS.length)]
  : RAW_SUBREDDIT;
const PROXY_FILTER = process.env.PROXY_URL || 'residential brightdata us';

// Persona + identity rotation centralized in WSession.start (opts.platform).
const s = await WSession.start({ label: 'reddit_register_then_handoff', proxy: PROXY_FILTER, targetHost: 'www.reddit.com', platform: 'reddit' });
const id = { first: s.identity.firstName, last: s.identity.lastName, username: s.identity.username, email: s.identity.email, password: s.identity.password, name: `${s.identity.firstName} ${s.identity.lastName}` };
console.log(`[register] identity: ${id.username} ${id.email}`);

async function vpJitter() {
  const vp = s.page.viewportSize();
  if (!vp) return;
  await humanMove(s.page, 100 + Math.floor(Math.random() * (vp.width - 200)), 100 + Math.floor(Math.random() * (vp.height - 200)));
}

try {
  // ===== REGISTRATION (mirrors reddit_register_then_comment.mjs) =====
  await s.page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');
  await vpJitter();

  const emailIn = s.page.locator('input[type="email"], input[name="email"], input[autocomplete="email"]').filter({ visible: true }).first();
  await emailIn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, emailIn);
  await humanIdlePause('short');
  await humanType(s.page, id.email);
  await humanIdlePause('short');
  await vpJitter();
  await humanClickLocator(s.page, s.page.getByRole('button', { name: /continue/i }).filter({ visible: true }).first());
  console.log('[register] submitted email');

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

  await humanIdlePause('deliberate');
  await vpJitter();
  const userIn = s.page.locator('input[name="username"], input[autocomplete="username"]').filter({ visible: true }).first();
  await userIn.waitFor({ state: 'visible' });
  const beforeVal = await userIn.inputValue().catch(() => '?');
  console.log(`[register] username field BEFORE typing: "${beforeVal}"`);
  await humanClickLocator(s.page, userIn);
  // retry-allowed: Reddit signup auto-suggests usernames in the field even
  // after focus; the typed value gets silently overridden — verified
  // 2026-04-27. Up to 3 attempts: clear, type, verify the typed value stuck.
  for (let attempt = 0; attempt < 3; attempt++) {
    nativeSelectAllAndDelete();
    await humanIdlePause('short');
    await humanType(s.page, id.username);
    const afterTypeVal = await userIn.inputValue().catch(() => '?');
    console.log(`[register] username attempt ${attempt + 1}: after typing "${id.username}": "${afterTypeVal}"`);
    if (afterTypeVal === id.username) break;
  }
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

  for (let i = 0; i < 20; i++) {
    await humanIdlePause('short');
    const u = s.page.url();
    if (!/\/register/.test(u)) break;
  }
  console.log(`[register] post-signup url=${s.page.url()}`);

  const result = await s.saveAccount('reddit', { username: id.username, email: id.email, password: id.password, name: id.name });
  console.log(`[register] saveAccount: ${result}`);

  // Land on the subreddit so the human can pick a post and comment.
  await humanIdlePause('deliberate');
  await s.page.goto(`https://www.reddit.com/r/${SUBREDDIT}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});

  console.log('');
  console.log('================================================================');
  console.log(`[handoff] account: reddit/${id.username}`);
  console.log(`[handoff] subreddit: r/${SUBREDDIT}`);
  console.log('[handoff] BROWSER IS YOURS — drive the comment flow now.');
  console.log('[handoff] Pick a post, click the composer, type a comment, submit.');
  console.log('[handoff] Verify it is publicly visible (open another browser, unauth).');
  console.log('[handoff] Press Ctrl+C in this terminal when done.');
  console.log('[handoff] Instrument file is being rewritten every 5s in:');
  console.log('[handoff]   .work/inst/reddit_register_then_handoff_*.json');
  console.log('================================================================');
  console.log('');

  // Idle forever. The WSession instrument loop (src/session/wsession.ts:137)
  // flushes the property-trap dump every 5s; we also keep the page alive by
  // touching its title periodically so Playwright does not surface idle
  // timeouts. Ctrl+C terminates and triggers WSession.close which writes
  // a final flush at line 393.
  let beats = 0;
  while (true) {
    await humanIdlePause();
    beats++;
    if (beats % 6 === 0) {
      // Touch the page so WSession knows we're alive; keeps any
      // health-check timeouts from firing.
      try {
        const url = s.page.url();
        const closed = s.page.isClosed?.() ?? false;
        console.log(`[handoff] heartbeat ${beats * 10}s url=${url.slice(0, 80)} closed=${closed}`);
        if (closed) {
          console.log('[handoff] page closed — assuming user finished, exiting');
          break;
        }
      } catch {}
    }
  }
} catch (e) {
  console.log(`[register] ERROR: ${e?.message || e}`);
  console.log('[register] stack:', e?.stack?.slice(0, 600));
  console.log('');
  console.log('[handoff] Registration failed. Browser is still open in case you');
  console.log('[handoff] want to continue manually. Ctrl+C to exit.');
  while (!s.page.isClosed?.()) {
    await humanIdlePause();
  }
} finally {
  try { await s.close?.(); } catch {}
}
