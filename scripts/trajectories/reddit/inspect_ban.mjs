/**
 * Reddit ban inspector — logs into an account, navigates to its own profile,
 * and dumps the full page text + any ban/suspension banners so we can see
 * why Reddit banned the account and whether there's an appeal option.
 *
 * Usage:
 *   ACCOUNT_ID=<id> xvfb-run -a node scripts/trajectories/reddit/inspect_ban.mjs
 *
 * Output: full page text + detected ban elements printed to stdout.
 */
import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account in DB'); process.exit(1); }
console.log(`[inspect] account: ${acct.username}`);

const { proxyUrl } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'reddit_inspect_ban', proxy: proxyUrl, browser: 'chromium', targetHost: 'www.reddit.com' });

try {
  // Inject stored cookies so we're logged in
  const stored = Array.isArray(acct.metadata?.cookies) ? acct.metadata.cookies : [];
  const hasSession = stored.some(c => /reddit_session/.test(c?.name ?? ''));
  if (hasSession) {
    const prepared = stored.filter(c => c?.name && c?.value && (c.domain || c.url)).map(c => ({ ...c, path: c.path || '/' }));
    await s.ctx.addCookies(prepared);
    console.log(`[inspect] injected ${prepared.length} cookies`);
  }

  // Navigate to own profile
  const profileUrl = `https://www.reddit.com/user/${acct.username}/`;
  await s.page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(5000);

  const finalUrl = s.page.url();
  const fullText = await s.page.evaluate(() => document.body?.innerText?.slice(0, 5000) ?? '');
  console.log(`[inspect] url: ${finalUrl}`);
  console.log(`[inspect] page text:\n${fullText}`);

  // Find ban/suspension/restriction elements
  const banEls = await s.page.evaluate(() => {
    const results = [];
    const keywords = /ban|suspend|restrict|deactivat|blocked|removed|appeal|violation/i;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const el = walker.currentNode;
      const text = (el.innerText || '').trim();
      const cls = String(el.className || '').slice(0, 100);
      const tag = el.tagName || '';
      if (keywords.test(text) && text.length < 500) {
        results.push({ tag, cls, text });
      }
    }
    return results;
  });
  console.log(`[inspect] ban elements: ${JSON.stringify(banEls, null, 2)}`);
} catch (e) {
  console.log(`[inspect] error: ${e.message}`);
} finally {
  await s.close();
}
