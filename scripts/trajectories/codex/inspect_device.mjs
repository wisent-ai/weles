import { WSession } from '../../../dist/session/wsession.js';
const session = await WSession.start({ label:'inspect', headless:false, browser:'chromium' });
const page = session.page;
await page.goto('https://auth.openai.com/codex/device?user_code=TEST-TEST&binding_code=TEST', { waitUntil:'networkidle' });
await page.waitForTimeout(3000);
const info = await page.evaluate(() => {
  const iframes = Array.from(document.querySelectorAll('iframe')).map(f => ({ src: f.src, id: f.id, class: f.className }));
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).map(b => ({
    txt: (b.innerText || b.textContent || '').trim().slice(0,60),
    tag: b.tagName,
    type: b.type,
    onclick: b.getAttribute('onclick'),
    id: b.id,
    class: b.className.slice(0,80),
    disabled: b.disabled,
  }));
  return { url: location.href, title: document.title, body: (document.body?.innerText||'').slice(0,500), iframes, buttons };
});
console.log(JSON.stringify(info, null, 2));
await session.close();
