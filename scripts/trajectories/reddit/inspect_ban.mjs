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
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account in DB'); process.exit(1); }
console.log(`[inspect] account: ${acct.username}`);

const { proxyUrl } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'reddit_inspect_ban', proxy: proxyUrl, targetHost: 'www.reddit.com' });

try {
  // Inject stored cookies so we're logged in
  const stored = Array.isArray(acct.metadata?.cookies) ? acct.metadata.cookies : [];
  const hasSession = stored.some(c => /reddit_session/.test(c?.name ?? ''));
  if (hasSession) {
    const prepared = stored.filter(c => c?.name && c?.value && (c.domain || c.url)).map(c => ({ ...c, path: c.path || '/' }));
    await s.ctx.addCookies(prepared);
    console.log(`[inspect] injected ${prepared.length} cookies`);
  }

  // Navigate to homepage first (this is where ban banners usually appear)
  await s.page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded' });
  // Reddit SPA needs time to hydrate — wait for content to appear
  await humanIdlePause('long');
  const homeUrl = s.page.url();
  const homeText = await s.page.evaluate(() => document.body?.innerText?.slice(0, 8000) ?? '');
  await s.page.screenshot({ path: `${runRecordingsDir('reddit_inspect_ban')}/homepage_logged_in.png` });
  console.log(`[inspect] homepage url: ${homeUrl}`);
  console.log(`[inspect] homepage text:\n${homeText}`);

  // Find ban/suspension/restriction elements on homepage
  const homeBanEls = await s.page.evaluate(() => {
    const results = [];
    const keywords = /ban|suspend|restrict|deactivat|blocked|removed|appeal|violation|shadow/i;
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
  console.log(`[inspect] ban elements on homepage (logged-in): ${JSON.stringify(homeBanEls, null, 2)}`);

  // Now navigate to own profile
  const profileUrl = `https://www.reddit.com/user/${acct.username}/`;
  await s.page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  const finalUrl = s.page.url();
  const fullText = await s.page.evaluate(() => document.body?.innerText?.slice(0, 8000) ?? '');
  await s.page.screenshot({ path: `${runRecordingsDir('reddit_inspect_ban')}/profile_logged_in.png` });
  console.log(`[inspect] profile url: ${finalUrl}`);
  console.log(`[inspect] profile text:\n${fullText}`);

  // Find ban/suspension/restriction elements
  const banEls = await s.page.evaluate(() => {
    const results = [];
    const keywords = /ban|suspend|restrict|deactivat|blocked|removed|appeal|violation|shadow/i;
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
  console.log(`[inspect] ban elements on profile (logged-in): ${JSON.stringify(banEls, null, 2)}`);

  // Now check the same profile WITHOUT cookies (logged-out view)
  console.log('[inspect] --- checking logged-out view ---');
  await s.ctx.clearCookies();
  await s.page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  const logoutUrl = s.page.url();
  const logoutText = await s.page.evaluate(() => document.body?.innerText?.slice(0, 3000) ?? '');
  console.log(`[inspect] logged-out url: ${logoutUrl}`);
  console.log(`[inspect] logged-out text:\n${logoutText}`);
  const logoutBanEls = await s.page.evaluate(() => {
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
  console.log(`[inspect] ban elements (logged-out): ${JSON.stringify(logoutBanEls, null, 2)}`);
} catch (e) {
  console.log(`[inspect] error: ${e.message}`);
} finally {
  await s.close();
}
