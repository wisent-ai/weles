// Reverse-engineer probe: find TikTok Ticket Guard signing JS.
// Loads signup page, collects all .js responses, greps for ticket-guard strings,
// and inspects window for crypto/signing globals.

import { WSession } from '../../dist/session/wsession.js';
import { humanIdlePause } from '../../dist/human/mouse.js';

const PATTERNS = 'ticket-guard|ticketGuard|TicketGuard|tt-ticket-guard|ticket_guard|guardPublicKey|guardVersion';

const s = await WSession.start({ label: 'probe_tg', proxy: process.env.PROBE_PROXY || undefined });

// Collect .js response bodies as they come in
const scripts = new Map();  // url -> body text
s.page.on('response', async (resp) => {
  try {
    const u = resp.url();
    const ct = resp.headers()['content-type'] || '';
    if (!/\.js(\?|$)|javascript/i.test(u + ct)) return;
    if (!u.includes('tiktok')) return;
    const text = await resp.text();
    scripts.set(u, text);
  } catch {}
});

try {
  await s.page.goto('https://www.tiktok.com/signup/phone-or-email/email', { waitUntil: 'networkidle' });
  await humanIdlePause('long');

  console.log(`\n=== captured ${scripts.size} TikTok JS files ===\n`);

  const re = new RegExp(PATTERNS, 'gi');
  const hits = [];
  for (const [url, body] of scripts) {
    const matches = body.match(re);
    if (matches) hits.push({ url, count: matches.length, size: body.length });
  }

  console.log(`=== ${hits.length} scripts with ticket-guard references ===\n`);
  for (const h of hits) {
    console.log(`  ${h.url.slice(-120)}  (${h.size}B)  matches=${h.count}`);
  }

  const winInfo = await s.page.evaluate(`(() => {
    const keys = Object.keys(window).filter(k => /ticket|guard|passport|signin|crypto|subtle/i.test(k));
    const chunks = Array.isArray(self.__LOADABLE_LOADED_CHUNKS__) ? self.__LOADABLE_LOADED_CHUNKS__.length : 0;
    return { winKeys: keys, chunksLoaded: chunks, hasSubtle: !!crypto?.subtle };
  })()`).catch(e => ({ error: e.message }));
  console.log(`\n=== window-level hints ===`);
  console.log(JSON.stringify(winInfo, null, 2));

  if (hits.length) {
    const top = hits.sort((a, b) => b.count - a.count)[0];
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync('recordings/probe_tg', { recursive: true });
    const fname = `recordings/probe_tg/${top.url.split('/').pop().split('?')[0]}`;
    writeFileSync(fname, scripts.get(top.url));
    console.log(`\nSaved top candidate to ${fname}`);
  }
} catch (e) {
  console.error('ERR:', e.message);
} finally {
  await s.close().catch(() => {});
}
