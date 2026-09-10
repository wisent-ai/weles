// What the report page shows, and the date preset control on it.
import { humanClickLocator } from '../../../../../dist/human/mouse.js';

export async function collectPageState(page) {
  return await page.evaluate(() => {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const short = (value, max = 600) => norm(value).slice(0, max);
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      return style && style.visibility !== 'hidden' && style.display !== 'none'
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const cssPath = (el) => {
      const parts = [];
      let node = el;
      while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
        let part = node.localName || node.tagName.toLowerCase();
        if (node.id) {
          part += `#${node.id}`;
          parts.unshift(part);
          break;
        }
        const parent = node.parentElement || node.getRootNode()?.host || null;
        if (parent?.children) {
          const same = Array.from(parent.children).filter((child) => child.localName === node.localName);
          if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.join(' > ');
    };
    const roots = [];
    const addRoot = (root, label) => {
      roots.push({ root, label });
      for (const el of Array.from(root.querySelectorAll('*'))) {
        if (el.shadowRoot) addRoot(el.shadowRoot, `${label} >> ${el.localName}`);
      }
    };
    addRoot(document, 'document');

    const all = [];
    for (const { root, label } of roots) {
      for (const el of Array.from(root.querySelectorAll('*'))) all.push({ el, root: label });
    }

    const controls = all
      .filter(({ el }) => /^(a|button|input|select|textarea|option)$/i.test(el.tagName)
        || el.getAttribute('role')
        || el.onclick
        || el.tabIndex >= 0
        || /button|select|dropdown|calendar|date|menu|filter|download|export/i.test(el.className || ''))
      .map(({ el, root }, index) => {
        const rect = el.getBoundingClientRect();
        return {
          index,
          root,
          tag: el.tagName,
          role: el.getAttribute('role') || '',
          type: el.getAttribute('type') || '',
          id: el.id || '',
          name: el.getAttribute('name') || '',
          className: String(el.className || '').slice(0, 160),
          text: short(el.innerText || el.textContent || '', 240),
          ariaLabel: el.getAttribute('aria-label') || '',
          title: el.getAttribute('title') || '',
          placeholder: el.getAttribute('placeholder') || '',
          value: 'value' in el ? short(el.value, 240) : '',
          href: el.href || '',
          checked: Boolean(el.checked),
          selected: Boolean(el.selected),
          disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
          expanded: el.getAttribute('aria-expanded') || '',
          visible: visible(el),
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          path: cssPath(el),
        };
      })
      .filter((item) => item.visible || item.text || item.ariaLabel || item.value || item.href)
      .slice(0, 1000);

    const rows = all
      .filter(({ el }) => /^(tr|li|section|article)$/i.test(el.tagName) || el.getAttribute('role') === 'row')
      .map(({ el, root }) => ({
        root,
        tag: el.tagName,
        role: el.getAttribute('role') || '',
        text: short(el.innerText || el.textContent || '', 900),
        visible: visible(el),
        path: cssPath(el),
      }))
      .filter((row) => row.visible && row.text)
      .slice(0, 500);

    const storage = {};
    for (const storeName of ['localStorage', 'sessionStorage']) {
      try {
        const store = window[storeName];
        storage[storeName] = Array.from({ length: store.length }, (_, i) => {
          const key = store.key(i);
          const value = key ? store.getItem(key) : '';
          return {
            key,
            valueLength: value?.length || 0,
            valuePreview: /date|report|campaign|org|account|app|time|filter/i.test(key || '') ? short(value, 500) : undefined,
          };
        });
      } catch {
        storage[storeName] = [];
      }
    }

    const resources = performance.getEntriesByType('resource')
      .map((entry) => ({
        name: entry.name,
        initiatorType: entry.initiatorType,
        transferSize: Math.round(entry.transferSize || 0),
        duration: Math.round(entry.duration || 0),
      }))
      .filter((entry) => /app-ads\.apple\.com|searchads|report|campaign|budget|spend|analytics|api/i.test(entry.name))
      .slice(-300);

    return {
      url: location.href,
      title: document.title,
      text: short(document.body?.innerText || document.body?.textContent || '', 10000),
      controls,
      rows,
      storage,
      resources,
    };
  });
}

export async function clickDatePreset(page, label) {
  try {
    const opener = page.locator([
      'apui-wc-date-range-picker .date-range-picker__main-content',
      'apui-wc-date-range-picker .form-input--date-range-picker',
      'apui-wc-date-range-picker .date-range-picker',
      '.table-toolbar__date',
      '.date-range-picker',
    ].join(', ')).filter({ visible: true }).first();
    if (await opener.count() === 0) return { ok: false, stage: 'open', reason: 'date picker opener not found' };
    await humanClickLocator(page, opener);
    await page.waitForTimeout(500);

    const item = page.getByText(label, { exact: true }).filter({ visible: true }).first();
    if (await item.count() === 0) return { ok: false, stage: 'select', reason: `preset not found: ${label}` };
    const clickable = item.locator('xpath=ancestor-or-self::*[self::li or self::button or self::a or @role="button"][1]').or(item).first();
    await humanClickLocator(page, clickable);
    await page.waitForTimeout(1500);
    const detail = await clickable.evaluate((el) => ({
      tag: el.tagName,
      text: String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
      className: String(el.className || ''),
      visible: Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
      url: location.href,
    }));
    return { ok: true, stage: 'select', label, ...detail };
  } catch (error) {
    return { ok: false, stage: 'exception', reason: error.message };
  }
}
