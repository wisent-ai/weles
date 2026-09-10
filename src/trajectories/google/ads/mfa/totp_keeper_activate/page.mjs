// The page as the keeper reports and drives it.
import { action } from './keeper.mjs';

export async function state() {
  const res = await action({
    action: 'eval',
    js: `(() => ({
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 7000),
      inputs: Array.from(document.querySelectorAll('input')).map((el) => ({
        type: el.getAttribute('type') || '',
        name: el.getAttribute('name') || '',
        autocomplete: el.getAttribute('autocomplete') || '',
        placeholder: el.getAttribute('placeholder') || '',
        aria: el.getAttribute('aria-label') || '',
        visible: Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
        valueLength: String(el.value || '').length,
      })).slice(0, 40),
      controls: Array.from(document.querySelectorAll('button, [role="button"], a, [role="link"], li, div[role="option"]')).map((el) => ({
        tag: (el.tagName || '').toLowerCase(),
        role: el.getAttribute('role') || '',
        text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
        href: el.href || '',
        aria: el.getAttribute('aria-label') || '',
      })).filter((item) => item.text || item.href || item.aria).slice(0, 120),
    }))()`,
  });
  return res.result || { url: '', text: '', controls: [], inputs: [] };
}

export async function idle(kind = 'deliberate') {
  await action({ action: 'humanidle', kind }, 30_000).catch(() => {});
}

export async function nav(url) {
  await action({ action: 'nav', url }, 120_000);
  await idle('deliberate');
}

export function selectorForText(text) {
  const escaped = String(text).replace(/"/g, '\\"');
  return `button:has-text("${escaped}"), [role="button"]:has-text("${escaped}"), a:has-text("${escaped}"), [role="link"]:has-text("${escaped}"), li:has-text("${escaped}"), div[role="option"]:has-text("${escaped}")`;
}

export async function clickText(values) {
  const list = Array.isArray(values) ? values : [values];
  let last = null;
  for (const value of list) {
    try {
      await action({ action: 'click', selector: selectorForText(value) }, 30_000);
      await idle('deliberate');
      return value;
    } catch (error) {
      last = error;
    }
    const needle = JSON.stringify(String(value).toLowerCase());
    const hit = await action({
      action: 'eval',
      js: `(() => {
        const needle = ${needle};
        const norm = (v) => String(v || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        const visible = (el) => {
          const r = el.getBoundingClientRect?.();
          if (!r || r.width < 2 || r.height < 2) return false;
          const st = getComputedStyle(el);
          return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity || '1') !== 0;
        };
        const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, [role="link"], li, div[role="option"]'));
        return nodes.map((el) => {
          if (!visible(el)) return null;
          const text = norm(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
          if (!text.includes(needle)) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, area: r.width * r.height };
        }).filter(Boolean).sort((a, b) => a.area - b.area)[0] || null;
      })()`,
    }, 10_000).catch(() => null);
    if (hit?.result) {
      await action({ action: 'humanclick', x: hit.result.x, y: hit.result.y }, 30_000);
      await idle('deliberate');
      return value;
    }
  }
  throw last || new Error(`clickText failed: ${list.join(', ')}`);
}

export async function fill(selector, text) {
  await action({ action: 'fill_fast', selector, text }, 30_000)
    .catch(() => action({ action: 'set_value', selector, text }, 30_000));
  await idle('short');
}

export async function press(key) {
  await action({ action: 'press', key }, 30_000);
  await idle('deliberate');
}
