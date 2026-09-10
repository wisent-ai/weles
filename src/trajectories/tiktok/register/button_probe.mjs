/**
 * Read a form button's enabled state and geometry, and start recording every
 * click the document receives into window.__wclick so a click that never
 * reached the button can be told apart from one TikTok ignored.
 *
 * `finder` is 'send-code' for the [data-e2e="send-code-button"] control or
 * 'next' for the button whose text is exactly "Next".
 */
export function probeButton(page, finder) {
  return page.evaluate((which) => {
    const btn = which === 'send-code'
      ? document.querySelector('[data-e2e="send-code-button"]')
      : Array.from(document.querySelectorAll('button')).find(b => /^\s*next\s*$/i.test((b.textContent || '').trim()));
    if (!btn) return { present: false };
    const r = btn.getBoundingClientRect();
    window.__wclick = [];
    document.addEventListener('click', e => {
      const el = e.target;
      const r2 = el.getBoundingClientRect ? el.getBoundingClientRect() : {};
      window.__wclick.push({
        tag: el.tagName,
        text: (el.textContent || '').trim().slice(0, 40),
        id: el.id,
        cls: (el.className || '').toString().slice(0, 60),
        dataE2e: el.getAttribute && el.getAttribute('data-e2e'),
        isTrusted: e.isTrusted,
        clientX: e.clientX,
        clientY: e.clientY,
        targetRect: { x: r2.x, y: r2.y, w: r2.width, h: r2.height },
      });
    }, true);
    return { present: true, disabled: btn.disabled, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, center: { x: r.x + r.width/2, y: r.y + r.height/2 } };
  }, finder).catch((e) => ({ error: e.message }));
}

/** The clicks recorded since the last probe, as JSON text. */
export function recordedClicks(page) {
  return page.evaluate('JSON.stringify(window.__wclick || [])').catch((e) => `unreadable: ${e.message}`);
}
