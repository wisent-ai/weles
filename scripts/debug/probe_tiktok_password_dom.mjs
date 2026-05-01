#!/usr/bin/env node
// Open TikTok /signup/phone-or-email/email and dump every input's tag/type/
// name/placeholder/aria-label/className so we know why s.fill('Password')
// is finding the input but writing 0 chars to it.

import { WSession } from '../../dist/session/wsession.js';
import { generatePersona } from '../../dist/browser/persona.js';
import { humanClickLocator } from '../../dist/human/mouse.js';

const s = await WSession.start({ label: 'probe_pw_dom', proxy: process.env.PROXY_URL || 'residential', persona: generatePersona({ country: 'US', browser: 'chromium' }) });
try {
  await s.goto('https://www.tiktok.com/signup');
  await s.wait(5);
  await s.click('Use phone or email');
  await s.wait(2);
  await s.click('Sign up with email');
  await s.wait(3);

  const dump = await s.page.evaluate(`(()=>{
    function vis(el){var r=el.getBoundingClientRect();return r.width>0&&r.height>0&&el.offsetParent!==null;}
    const inputs = Array.from(document.querySelectorAll('input,textarea,[contenteditable="true"]'));
    return inputs.filter(vis).map(el => {
      const r = el.getBoundingClientRect();
      const attrs = {};
      for (const a of el.attributes) attrs[a.name] = a.value;
      return {
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type'),
        name: el.getAttribute('name'),
        placeholder: el.getAttribute('placeholder'),
        ariaLabel: el.getAttribute('aria-label'),
        autocomplete: el.getAttribute('autocomplete'),
        cls: (el.className || '').toString().slice(0, 80),
        bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        valueLen: (el.value || '').length,
        outerHTMLPrefix: el.outerHTML.slice(0, 200),
      };
    });
  })()`);
  console.log(JSON.stringify(dump, null, 2));
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200), e.stack?.slice(0, 200));
} finally {
  await s.close();
}
