// The browser this runner does not own. Every exchange with the keeper is one
// JSON line over its socket: the command, the human pause after it, what the
// page currently shows, where a named control sits, and the click or fill that
// changes it. Nothing here is retried behind the caller's back — a command the
// keeper refused comes back as an error.

import { keeperRequest } from '../../../../_shared/keeper/client.mjs';
import { SOCK, keywords } from './run_brief.mjs';

// Shared by both page scripts: an attribute the element does not carry reads as
// no value, which is a real answer about the element and not a failed read.
const PAGE_HELPERS = `
      const attr = (el, name) => (el.hasAttribute(name) ? el.getAttribute(name) : '');
      const norm = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => {
        const r = el.getBoundingClientRect?.();
        if (!r || r.width < 2 || r.height < 2) return false;
        const st = getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity || '1') !== 0;
      };`;

const CONTROL_NODES =
  'button, [role="button"], [role="menuitem"], a, [role="link"], li, div[role="option"], material-button, material-list-item';

export async function action(cmd) {
  const answer = await keeperRequest(SOCK, cmd);
  if (!answer.ok)
    throw new Error(answer.error || `keeper action failed: ${cmd.action}`);
  return answer;
}

export async function idle(kind = 'deliberate') {
  await action({ action: 'humanidle', kind });
}

export async function nav(url) {
  await action({ action: 'nav', url });
  await idle('deliberate');
}

export async function press(key) {
  await action({ action: 'press', key });
  await idle('deliberate');
}

export async function evalState() {
  const res = await action({
    action: 'eval',
    js: `(() => {${PAGE_HELPERS}
      return {
        url: location.href,
        title: document.title,
        text: document.body?.innerText || '',
        inputs: Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"]')).map((el) => ({
          tag: (el.tagName || '').toLowerCase(),
          type: attr(el, 'type'),
          name: attr(el, 'name'),
          role: attr(el, 'role'),
          aria: attr(el, 'aria-label'),
          placeholder: attr(el, 'placeholder'),
          value: String(el.value || el.textContent || ''),
          visible: visible(el),
        })),
        controls: Array.from(document.querySelectorAll('${CONTROL_NODES}')).map((el) => {
          const r = el.getBoundingClientRect();
          return {
            tag: (el.tagName || '').toLowerCase(),
            role: attr(el, 'role'),
            text: norm(el.innerText || el.textContent || ''),
            aria: attr(el, 'aria-label'),
            href: el.href || '',
            visible: visible(el),
            x: r.left,
            y: r.top,
            w: r.width,
            h: r.height,
          };
        }).filter((item) => item.visible && (item.text || item.aria || item.href)),
      };
    })()`,
  });
  if (!res.result)
    throw new Error(
      'keeper ran the page-state script but answered with no document; the tab did not report its state',
    );
  return res.result;
}

// Every visible control whose text, label or link matches, smallest first, so
// the control itself wins over a container that merely holds its text.
// options.minY / options.maxY keep only controls whose top edge lies in that band.
export async function locateControl(patternSource, options = {}) {
  const source = JSON.stringify(patternSource);
  const minY = options.minY === undefined ? '-Infinity' : Number(options.minY);
  const maxY = options.maxY === undefined ? 'Infinity' : Number(options.maxY);
  const res = await action({
    action: 'eval',
    js: `(() => {${PAGE_HELPERS}
      const re = new RegExp(${source}, 'i');
      const nodes = Array.from(document.querySelectorAll('${CONTROL_NODES}'));
      return nodes.map((el, index) => {
        const text = norm(el.innerText || el.textContent || '');
        const aria = attr(el, 'aria-label');
        const haystack = norm(text + ' ' + aria + ' ' + (el.href || ''));
        if (!visible(el) || !re.test(haystack)) return null;
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if (r.top < ${minY} || r.top > ${maxY}) return null;
        return { index, tag: (el.tagName || '').toLowerCase(), role: attr(el, 'role'), text, aria, href: el.href || '', x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, area };
      }).filter(Boolean).sort((a, b) => a.area - b.area);
    })()`,
  });
  if (!Array.isArray(res.result))
    throw new Error(
      `keeper ran the control search for ${patternSource} but answered with no match list`,
    );
  return res.result;
}

export async function humanClickPoint(x, y, label) {
  console.log(
    `[google-ads-keyword-planner-keeper] clicking ${label} at ${Math.round(x)},${Math.round(y)}`,
  );
  await action({ action: 'humanclick', x, y });
  await idle('deliberate');
}

export async function clickControl(patternSource, label, options = {}) {
  const matches = await locateControl(patternSource, options);
  if (!matches.length) return false;
  const target = matches[0];
  await humanClickPoint(
    target.cx,
    target.cy,
    label || target.text || target.aria || patternSource,
  );
  return true;
}

export async function fillSelector(selector, text, label) {
  console.log(
    `[google-ads-keyword-planner-keeper] filling ${label || selector}`,
  );
  await action({ action: 'fill', selector, text });
  await idle('deliberate');
}

// The planner's keyword box is the control whose label carries "keywords" or
// "paste" — the same control chooseVolumeMode waits for. The box counts as
// filled when the value it reports is the text this run sent (a box that drops
// the line breaks still reports its start). If nothing on screen reports that,
// the form is not the one this run was written against.
export async function fillKeywordInput() {
  const text = keywords.join('\n');
  console.log('[google-ads-keyword-planner-keeper] filling keyword input');
  await action({
    action: 'fill',
    selector:
      'textarea[aria-label*="keywords" i], textarea[aria-label*="paste" i], [role="textbox"][aria-label*="keywords" i]',
    text,
  });
  await idle('deliberate');
  const state = await evalState();
  const landed = state.inputs.some((input) => {
    const value = String(input.value || '');
    return value.length > 0 && text.startsWith(value);
  });
  if (!landed) {
    throw new Error(
      `keyword box did not take the ${keywords.length} keyword(s) of this run; the form on screen is not the keyword entry form`,
    );
  }
}

export async function dismissChrome() {
  await action({
    action: 'eval',
    js: `(() => {
      const overlays = Array.from(document.querySelectorAll('.ad-blocker-detected-overlay, [class*="ad-blocker"], [class*="adblock"]'));
      for (const el of overlays) {
        el.style.pointerEvents = 'none';
        el.style.opacity = '0';
        el.style.display = 'none';
      }
      return overlays.length;
    })()`,
  });
  await clickControl(
    'Close notifications|Get the Google Ads app dismiss|Close setup',
    'dismiss overlay',
    { maxArea: 80_000 },
  ).catch(() => false);
}
