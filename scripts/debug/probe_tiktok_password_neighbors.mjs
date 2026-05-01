#!/usr/bin/env node
// Dump every element whose bounding box overlaps the password input's bbox.
// Goal: identify the show-password toggle (eye icon) sitting at the right
// edge — humanClickLocator's randomized in-element offset is hitting it
// instead of the input, which flips type from password to text and gives
// the click to the toggle so subsequent keystrokes don't land on the input.

import { WSession } from '../../dist/session/wsession.js';
import { generatePersona } from '../../dist/browser/persona.js';

const s = await WSession.start({ label: 'probe_pw_neighbors', proxy: process.env.PROXY_URL || 'residential', persona: generatePersona({ country: 'US', browser: 'chromium' }) });
try {
  await s.goto('https://www.tiktok.com/signup');
  await s.wait(5);
  await s.click('Use phone or email');
  await s.wait(2);
  await s.click('Sign up with email');
  await s.wait(3);
  await s.select('month', 'June');
  await s.select('day', '15');
  await s.select('year', '1995');
  await s.wait(2);

  const dump = await s.page.evaluate(`(() => {
    const pw = document.querySelector('input[type="password"]');
    if (!pw) return { error: 'no password input' };
    const r = pw.getBoundingClientRect();
    const ext = { x: r.x - 20, y: r.y - 5, x2: r.x + r.width + 20, y2: r.y + r.height + 5 };
    const all = Array.from(document.querySelectorAll('*'));
    const hits = [];
    for (const el of all) {
      if (el === pw) continue;
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      const overlap = !(b.x + b.width < ext.x || b.x > ext.x2 || b.y + b.height < ext.y || b.y > ext.y2);
      if (!overlap) continue;
      // Skip very large containers
      if (b.width > 500 || b.height > 100) continue;
      const attrs = {};
      for (const a of el.attributes) attrs[a.name] = a.value;
      hits.push({
        tag: el.tagName.toLowerCase(),
        bbox: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
        cls: (el.className || '').toString().slice(0, 80),
        role: el.getAttribute('role'),
        text: (el.textContent || '').trim().slice(0, 30),
        attrs: Object.entries(attrs).slice(0, 5).map(([k,v]) => k + '=' + v.slice(0, 40)),
      });
    }
    return { input: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, neighbors: hits };
  })()`);
  console.log(JSON.stringify(dump, null, 2));
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
} finally {
  await s.close();
}
