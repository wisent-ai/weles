// Use WSession (bypasses Cloudflare) to fetch PH homepage and extract the
// current day's top launch URL (/posts/<slug>). Used to feed comment.mjs a
// real comment-capable target URL instead of the product overview page.
import { WSession } from '../../../dist/session/wsession.js';

const s = await WSession.start({ label: 'ph_find_launch' });
try {
  await s.goto('https://www.producthunt.com/');
  await new Promise(r => setTimeout(r, 4000));
  const posts = await s.page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href^="/p/"]'));
    return Array.from(new Set(links.map(a => a.getAttribute('href'))));
  });
  console.log(JSON.stringify(posts, null, 2));
} finally { await s.close().catch(() => {}); }
