/**
 * DOM probe for shreddit-composer sub-components.
 * Designed to run inside page.evaluate(). Searches both shadowRoot
 * AND light DOM (Reddit's submit button is in the light DOM).
 */
export function findComposerPart(part) {
  function dig(root, predicate) {
    const queue = [root];
    while (queue.length) {
      const node = queue.shift();
      if (!node) continue;
      if (node.nodeType === Node.ELEMENT_NODE && predicate(node)) return node;
      if (node.shadowRoot) queue.push(node.shadowRoot);
      if (node.children) queue.push(...node.children);
    }
    return null;
  }
  const composers = Array.from(document.querySelectorAll('shreddit-composer'));
  const composer = composers.find((sc) => {
    const r = sc.getBoundingClientRect();
    return r.width > 20 && r.height > 20;
  }) || composers[0];
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return r.width > 8 && r.height > 8 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const visibleFaceplate = () => {
    const inputs = Array.from(document.querySelectorAll('faceplate-textarea-input[placeholder="Join the conversation"]'));
    const el = inputs.find(isVisible);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(40, r.width / 2), y: r.top + Math.min(22, r.height / 2), w: r.width, h: r.height, tag: el.tagName.toLowerCase(), text: (el.textContent || el.getAttribute('placeholder') || '').trim().slice(0, 80) };
  };
  if (part === 'editable') {
    if (!composer) return null;
    const el = dig(composer, (e) => {
      if (!isVisible(e)) return false;
      if (e.getAttribute('contenteditable') === 'true') return true;
      if (e.matches?.('[role="textbox"], textarea')) return true;
      return false;
    });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(40, r.width / 2), y: r.top + Math.min(24, r.height / 2), w: r.width, h: r.height, tag: el.tagName.toLowerCase() };
  }
  if (part === 'placeholder') {
    const fp = visibleFaceplate();
    if (fp) return fp;
    if (!composer) return null;
    const el = dig(composer, (e) => {
      if (!isVisible(e)) return false;
      const text = (e.textContent || '').trim().toLowerCase();
      if (e.classList?.contains('cursor-text')) return true;
      if (text.includes('join the conversation')) return true;
      return false;
    }) || composer;
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(44, r.width / 2), y: r.top + Math.min(24, r.height / 2), w: r.width, h: r.height, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 80) };
  }
  if (!composer) return null;
  const el = dig(composer, (e) => {
    if (!isVisible(e)) return false;
    const tag = e.tagName.toLowerCase();
    const type = (e.getAttribute('type') || '').toLowerCase();
    if (type !== 'submit' && !tag.includes('button')) return false;
    const text = (e.textContent || e.getAttribute('aria-label') || '').trim().toLowerCase();
    if (!text.includes('comment') && !text.includes('reply') && !text.includes('submit')) return false;
    if (e.disabled || e.getAttribute('aria-disabled') === 'true') return false;
    return true;
  });
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 80) };
}
