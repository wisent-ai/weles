import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { loadFreshCookieJarOrFail } from '../_shared/cookie-freshness.mjs';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const TARGET = process.env.TARGET_URL || 'https://www.tiktok.com/foryou';
const acct = await getSocialAccount('tiktok');
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'tiktok_probe_video_actions', proxy: proxyUrl, persona });
try {
  const all = loadFreshCookieJarOrFail(acct, { platform: 'tiktok', label: 'tiktok_probe_video_actions', currentProxyUrl: proxyUrl, currentPersona: persona });
  const stored = all.filter(c => /tiktok\.com/.test(c.domain ?? ''));
  await s.ctx.addCookies(stored.map(c => ({ ...c, path: c.path || '/' })));
  // Capture every /api/ response with body length & head — diagnoses cases
  // where TikTok serves status=200 but empty body to suspicious sessions.
  const apiResponses = [];
  s.page.on('response', async (r) => {
    const u = r.url();
    if (!/tiktok\.com\/api\//.test(u)) return;
    let body = '';
    try { body = await r.text(); } catch {}
    apiResponses.push({ status: r.status(), url: u.split('?')[0], len: body.length, head: body.slice(0, 200).replace(/\n/g, ' ') });
  });
  await s.page.goto(TARGET, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  if (process.env.PROBE_PROFILE) {
    await s.goto(`https://www.tiktok.com/${process.env.PROBE_PROFILE}`);
    await humanIdlePause('long');
  }
  await s.screenshot('after_goto').catch(() => {});
  console.log('[probe] /api/ responses captured:');
  for (const r of apiResponses) console.log(`  ${r.status} len=${r.len} ${r.url}`);
  const interesting = apiResponses.filter(r => /post\/item_list|repost\/item_list|item_list/.test(r.url));
  console.log('[probe] item_list responses (first 200 chars):');
  for (const r of interesting) console.log(`  ${r.url} -> status=${r.status} len=${r.len} head="${r.head}"`);
  const finalUrl = s.page.url();
  console.log('[probe] finalUrl:', finalUrl);
  const tags = await s.page.evaluate(() => {
    const e2e = [...new Set(Array.from(document.querySelectorAll('[data-e2e]')).map(e => e.getAttribute('data-e2e')))].sort();
    const allDataAttrs = new Set();
    Array.from(document.querySelectorAll('*')).forEach(el => Array.from(el.attributes).forEach(a => { if (a.name.startsWith('data-')) allDataAttrs.add(a.name); }));
    return { e2e, allDataAttrs: [...allDataAttrs].sort() };
  });
  console.log('[probe] all data-* attribute names:', JSON.stringify(tags.allDataAttrs));
  const e2eOnly = tags.e2e;
  // Look for any /video/ link or video-id source on /foryou
  const videoSources = await s.page.evaluate(() => {
    const links = [...new Set(Array.from(document.querySelectorAll('a[href*="/video/"]')).map(a => a.href))];
    const itemIds = [...new Set(Array.from(document.querySelectorAll('[data-item-id], [data-video-id]')).map(e => e.getAttribute('data-item-id') || e.getAttribute('data-video-id')))];
    const allAnchors = [...new Set(Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(h => /tiktok\.com/.test(h)))].slice(0, 30);
    const sigi = (() => {
      const el = document.querySelector('script#SIGI_STATE, script#__UNIVERSAL_DATA_FOR_REHYDRATION__');
      if (!el) return null;
      try { const d = JSON.parse(el.textContent); return Object.keys(d).slice(0, 20); } catch { return 'parse-err'; }
    })();
    return { links, itemIds, allAnchors, sigi };
  });
  console.log('[probe] video link sources on /foryou:', JSON.stringify(videoSources, null, 2));
  console.log('[probe] data-e2e tags on video page:');
  for (const t of e2eOnly) console.log('  ' + t);
  const actions = await s.page.evaluate(() => Array.from(document.querySelectorAll('button, [role="button"]')).filter(b => { const r = b.getBoundingClientRect(); return r.width > 20 && r.height > 20 && r.x >= 0 && r.y >= 0; }).map(b => { const r = b.getBoundingClientRect(); return ({ tag: b.tagName, e2e: b.getAttribute('data-e2e'), tid: b.getAttribute('data-testid'), aria: b.getAttribute('aria-label'), cls: (b.className||'').toString().slice(0,60), text: (b.innerText || '').trim().slice(0, 30), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }); }));
  console.log('[probe] right-rail buttons:');
  for (const a of actions) console.log('  ' + JSON.stringify(a));
} finally { await s.close().catch(() => {}); }
