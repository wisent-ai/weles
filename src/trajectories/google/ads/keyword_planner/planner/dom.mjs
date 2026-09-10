// The keyword rows as the planner page renders them.
import { keywords, norm } from './settings.mjs';

export async function collectDom(page) {
  return await page.evaluate(() => {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect?.();
      if (!rect || rect.width < 2 || rect.height < 2) return false;
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') === 0) return false;
      return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
    };
    const nodes = [];
    const seen = new Set();
    const visit = (root) => {
      for (const el of root.querySelectorAll?.('*') || []) {
        if (seen.has(el)) continue;
        seen.add(el);
        nodes.push(el);
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(document);
    const rows = nodes
      .filter((el) => visible(el) && (/^(tr|material-list-item)$/i.test(el.tagName || '') || el.getAttribute?.('role') === 'row'))
      .map((row) => norm(row.innerText || row.textContent || ''))
      .filter(Boolean)
      .slice(0, 300);
    const controls = nodes
      .filter((el) => visible(el) && (/^(a|button|input|textarea|material-button)$/i.test(el.tagName || '') || /button|menuitem|textbox/i.test(el.getAttribute?.('role') || '') || el.getAttribute?.('aria-label')))
      .map((el) => ({
        tag: (el.tagName || '').toLowerCase(),
        role: el.getAttribute?.('role') || '',
        text: norm(el.innerText || el.textContent || '').slice(0, 300),
        aria: el.getAttribute?.('aria-label') || '',
        title: el.getAttribute?.('title') || '',
        placeholder: el.getAttribute?.('placeholder') || '',
        value: norm(el.value || '').slice(0, 300),
      }))
      .filter((control) => /keyword|planner|search|forecast|volume|result|product|service|website|language|location|competition|bid|start|get|discover/i.test(`${control.text} ${control.aria} ${control.title} ${control.placeholder} ${control.value}`))
      .slice(0, 300);
    return {
      url: location.href,
      title: document.title,
      text: norm(document.body?.innerText || ''),
      rows,
      controls,
    };
  }).catch(() => ({ url: '', title: '', text: '', rows: [], controls: [] }));
}

export function parseVolumeText(value) {
  const text = norm(value);
  const range = text.match(/\b(\d+(?:[,.]\d+)?\s*[KM]?)\s*(?:-|–|to)\s*(\d+(?:[,.]\d+)?\s*[KM]?)\b/i);
  if (range) return range[0].replace(/\s+/g, ' ');
  const number = text.match(/\b\d+(?:[,.]\d+)?\s*[KM]?\b/i);
  return number ? number[0].replace(/\s+/g, ' ') : null;
}

export function parseKeywordRows(rows) {
  const parsed = [];
  for (const row of rows.map(norm).filter(Boolean)) {
    const matchedKeyword = keywords.find((keyword) => row.toLowerCase().includes(keyword.toLowerCase()));
    if (!matchedKeyword) continue;
    const volume = parseVolumeText(row);
    const competition = row.match(/\b(Low|Medium|High)\b/i)?.[1] || null;
    const bidMentions = [...row.matchAll(/(?:US)?[$£€]\s?\d+(?:[,.]\d+)?/g)].map((match) => match[0]);
    parsed.push({
      keyword: matchedKeyword,
      averageMonthlySearchesText: volume,
      competition,
      bidMentions,
      raw: row,
    });
  }
  return parsed;
}
