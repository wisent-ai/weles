import { getSocialAccount } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { humanIdlePause } from '../../dist/human/mouse.js';

const acct = await getSocialAccount('linkedin');
console.log(`account=${acct.username}`);
process.env.SVC_EMAIL = acct.metadata.email; process.env.SVC_PASSWORD = acct.metadata.password;
const s = await WSession.start({ label: 'probe_feed_dom', proxy: 'residential', targetHost: 'www.linkedin.com', browser: 'chromium' });
try {
  await s.goto('https://www.linkedin.com/feed/');
  await humanIdlePause('long');
  const url = s.page.url();
  console.log(`url=${url}`);
  const navMarkers = await s.page.evaluate(() => {
    const checks = ['nav.global-nav', '#global-nav', '.global-nav', '.global-nav__me', '.global-nav__me-photo', 'a[href="/feed/"]', '[data-test-global-nav-link]', 'header.global-nav'];
    return checks.map(s => ({ s, count: document.querySelectorAll(s).length }));
  });
  console.log('navMarkers=', JSON.stringify(navMarkers, null, 2));
} finally { await s.close(); }
