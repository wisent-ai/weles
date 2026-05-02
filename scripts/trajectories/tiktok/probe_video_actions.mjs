import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { loadFreshCookieJarOrFail } from '../_shared/cookie-freshness.mjs';

const TARGET = process.env.TARGET_URL || 'https://www.tiktok.com/@tiktok/video/7634616554583231774';
const acct = await getSocialAccount('tiktok');
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'tiktok_probe_video_actions', proxy: proxyUrl, persona });
try {
  const all = loadFreshCookieJarOrFail(acct, { platform: 'tiktok', label: 'tiktok_probe_video_actions', currentProxyUrl: proxyUrl, currentPersona: persona });
  const stored = all.filter(c => /tiktok\.com/.test(c.domain ?? ''));
  await s.ctx.addCookies(stored.map(c => ({ ...c, path: c.path || '/' })));
  await s.page.goto(TARGET, { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(10000);
  await s.screenshot('after_goto').catch(() => {});
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
  console.log('[probe] data-e2e tags on video page:');
  for (const t of e2eOnly) console.log('  ' + t);
  const actions = await s.page.evaluate(() => Array.from(document.querySelectorAll('button, [role="button"]')).filter(b => { const r = b.getBoundingClientRect(); return r.width > 20 && r.height > 20 && r.x >= 0 && r.y >= 0; }).map(b => { const r = b.getBoundingClientRect(); return ({ tag: b.tagName, e2e: b.getAttribute('data-e2e'), tid: b.getAttribute('data-testid'), aria: b.getAttribute('aria-label'), cls: (b.className||'').toString().slice(0,60), text: (b.innerText || '').trim().slice(0, 30), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }); }));
  console.log('[probe] right-rail buttons:');
  for (const a of actions) console.log('  ' + JSON.stringify(a));
} finally { await s.close().catch(() => {}); }
