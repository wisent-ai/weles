import { chromium } from 'playwright';

const endpoint = process.env.NCBR_BROWSER_ENDPOINT || 'http://127.0.0.1:9223';
const browser = await chromium.connectOverCDP(endpoint);
const context = browser.contexts()[0];
const page = context?.pages()[0];

if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2));
  process.exit(0);
}

const result = await page.evaluate(() => {
  function reactKeys(el) {
    return Object.keys(el || {}).filter((k) => k.startsWith('__react'));
  }
  function propsOf(el) {
    const propKey = reactKeys(el).find((k) => k.startsWith('__reactProps$'));
    const props = propKey ? el[propKey] : {};
    return {
      reactKeys: reactKeys(el),
      propKeys: Object.keys(props || {}),
      propTypes: Object.fromEntries(Object.entries(props || {}).map(([k, v]) => [k, typeof v])),
    };
  }
  const btn = document.querySelector('#login-btn') || Array.from(document.querySelectorAll('button')).find((b) => /zaloguj/i.test(b.innerText || ''));
  const mail = document.querySelector('#mail');
  const pass = document.querySelector('#password');
  const checkbox = document.querySelector('#isStatuteAccepted');
  const form = btn?.closest('form') || mail?.closest('form') || null;
  return {
    href: location.href,
    button: {
      exists: !!btn,
      text: btn?.innerText || '',
      disabled: btn?.disabled ?? null,
      rect: btn ? (() => { const r = btn.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })() : null,
      props: propsOf(btn),
    },
    form: {
      exists: !!form,
      tag: form?.tagName || null,
      action: form?.getAttribute('action') || null,
      method: form?.getAttribute('method') || null,
      props: propsOf(form),
    },
    mail: { exists: !!mail, valueLength: mail?.value?.length || 0, props: propsOf(mail) },
    pass: { exists: !!pass, valueLength: pass?.value?.length || 0, props: propsOf(pass) },
    checkbox: { exists: !!checkbox, checked: checkbox?.checked || false, props: propsOf(checkbox) },
  };
});

console.log(JSON.stringify(result, null, 2));
process.exit(0);
