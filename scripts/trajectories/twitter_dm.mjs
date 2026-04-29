import { getSocialAccount, resolveAccountSession } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const RECIPIENT = process.env.RECIPIENT_HANDLE || 'wisent_ai';
const MESSAGE = process.env.DM_MESSAGE || 'Hello from weles agent';

const acct = await getSocialAccount('twitter');
if (!acct) { console.log('FAIL: no active twitter account in DB'); process.exit(1); }
console.log(`[trajectory] Using account: ${acct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'twitter_dm', proxy: proxyUrl, persona });

try {
  // Cookie-first auth. twitter_dm previously ran full login inside, which
  // duplicated twitter_login's work and timed out the agent loop reliably
  // because Twitter's /i/flow/login resets the form on every Next click.
  // Inject stored auth_token + ct0 cookies; if they're stale, fail fast and
  // let twitter_login refresh them on the next routine tick.
  const stored = (acct.metadata?.cookies ?? []).filter(c => /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(c.domain ?? ''));
  if (!stored.length) { console.log('FAIL: no twitter cookies — login first'); process.exit(1); }
  await s.ctx.addCookies(stored.map(c => ({ ...c, path: c.path || '/' })));

  await s.page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(3000);
  if (/\/(i\/flow\/login|login)/.test(s.page.url())) {
    console.log(`FAIL: cookies stale, redirected to login (${s.page.url()})`);
    process.exit(1);
  }

  // Open the DM compose URL for the recipient. /messages/compose pre-fills the
  // To field so we don't have to drive the recipient-search dropdown.
  await s.page.goto(`https://x.com/messages/compose?recipient_id=&text=${encodeURIComponent(MESSAGE)}`, { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(2000);

  const result = await execute(s, `Compose a DM to @${RECIPIENT} with message "${MESSAGE}". If a recipient search field is shown, type "${RECIPIENT}" and pick the matching user. Click Next or the New Message button if prompted. Type the message into the message body if not already filled. Click Send. done(value="DM sent").`, {
    flowName: 'twitter_dm',
  });
  console.log('PASS:', result.value);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
