#!/usr/bin/env node
// Open TikTok /signup, find all elements containing "Use phone or email",
// dump their tag, role, attributes, and bbox so we know how to widen the
// click locator selector.

import { WSession } from '../../dist/session/wsession.js';

const s = await WSession.start({ label: 'probe_signup_dom', proxy: process.env.PROXY_URL || 'residential' });
try {
  await s.goto('https://www.tiktok.com/signup');
  await s.wait(5);

  const dump = await s.page.evaluate(`(()=>{
    const t = 'use phone or email';
    function vis(el){var r=el.getBoundingClientRect();return r.width>0&&r.height>0&&el.offsetParent!==null;}
    const all = Array.from(document.querySelectorAll('*'));
    const hits = [];
    for (const el of all) {
      const txt = (el.textContent || '').trim().toLowerCase();
      if (!txt.includes(t)) continue;
      // Skip very large containers — find the leaf-most match
      if (txt.length > 100) continue;
      const r = el.getBoundingClientRect();
      const attrs = {};
      for (const a of el.attributes) attrs[a.name] = a.value;
      hits.push({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().slice(0, 80),
        bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        visible: vis(el),
        role: el.getAttribute('role'),
        ariaLabel: el.getAttribute('aria-label'),
        dataE2e: el.getAttribute('data-e2e'),
        cls: el.className?.slice ? el.className.slice(0, 80) : '',
        parentTag: el.parentElement?.tagName?.toLowerCase(),
        parentRole: el.parentElement?.getAttribute('role'),
        parentClass: (el.parentElement?.className || '').slice ? (el.parentElement.className).slice(0, 80) : '',
      });
    }
    return hits;
  })()`);
  console.log(JSON.stringify(dump, null, 2));
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
} finally {
  await s.close();
}
