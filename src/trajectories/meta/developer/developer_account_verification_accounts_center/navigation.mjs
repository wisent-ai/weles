// Reaching the right place: a control by its visible text, the phone country, the account's
// stored phone, and the Accounts Center link.
import { humanType } from '../../../../../dist/human/keyboard.js';
import { WAIT_MS } from './settings.mjs';
import { normalizePhone, phoneCountry, phoneNationalNumber, sanitizedUrl } from './page.mjs';

export async function clickVisibleText(page, label, allow, includeDivs = false) {
  const selector = includeDivs
    ? 'button, [role="button"], [role="combobox"], [aria-haspopup], a, div, span'
    : 'button, [role="button"], [role="combobox"], [aria-haspopup], a';
  const target = await page.evaluate(({ selector, allowSource, allowFlags }) => {
    const allowRe = new RegExp(allowSource, allowFlags);
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll(selector))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: textOf(el),
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          area: rect.width * rect.height,
        };
      })
      .filter((item) => item.text && !item.disabled && allowRe.test(item.text))
      .sort((a, b) => a.area - b.area);
    return candidates[0] || null;
  }, {
    selector,
    allowSource: allow.source,
    allowFlags: allow.flags,
  }).catch(() => null);
  if (!target) return null;
  await page.mouse.click(target.x, target.y, { delay: 50 });
  await page.waitForTimeout(WAIT_MS).catch(() => {});
  console.log(JSON.stringify({ stage: 'clicked', label, text: target.text.slice(0, 80), x: target.x, y: target.y }));
  return target;
}

export async function selectCountryForPhone(page, phone) {
  if (phoneCountry(phone) !== '+48') return false;
  const opened = await clickVisibleText(page, 'country_selector', /United States\s*\(\+1\)|Country\s+United States/i, true);
  if (!opened) return false;
  let selected = await clickVisibleText(page, 'country_poland', /Poland\s*\(\+48\)|Polska\s*\(\+48\)/i, true);
  if (!selected) {
    await humanType(page, 'Poland').catch(() => {});
    await page.waitForTimeout(1000).catch(() => {});
    selected = await clickVisibleText(page, 'country_poland_after_search', /Poland\s*\(\+48\)|Polska\s*\(\+48\)/i, true);
  }
  return Boolean(selected);
}

export async function loadAccountPhone(page, preferredCountry) {
  await page.goto('https://accountscenter.facebook.com/youraccount/contact_points/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(WAIT_MS).catch(() => {});
  const rawPhones = await page.evaluate(() => {
    const textOf = (el) => [
      el.innerText || '',
      el.textContent || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
    ].join(' ');
    const text = [
      document.body?.innerText || '',
      document.body?.textContent || '',
      ...Array.from(document.querySelectorAll('button, [role="button"], a, input, [aria-label], [title]')).map(textOf),
    ].join(' ');
    const matches = text.match(/\+\d[\d\s().-]{6,}\d/g) || [];
    return Array.from(new Set(matches));
  });
  const candidates = rawPhones
    .map(normalizePhone)
    .filter(Boolean)
    .sort((a, b) => {
      if (a.country === preferredCountry && b.country !== preferredCountry) return -1;
      if (b.country === preferredCountry && a.country !== preferredCountry) return 1;
      return b.digitCount - a.digitCount;
    });
  const selected = candidates[0] || null;
  if (!selected) return null;
  console.log(JSON.stringify({
    stage: 'account_phone_candidate_loaded',
    country: selected.country,
    suffix: selected.suffix,
    digitCount: selected.digitCount,
    nationalDigitCount: phoneNationalNumber(selected.phone).length,
    candidates: candidates.length,
  }, null, 2));
  return selected.phone;
}

export async function clickAccountsCenter(page) {
  const target = await page.evaluate(() => {
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll('a, button, [role="button"]'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: textOf(el),
          href: el.getAttribute('href') || '',
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      })
      .filter((item) => !item.disabled && /Accounts Center/i.test(item.text));
    return candidates[0] || null;
  });
  if (!target) return null;
  await page.mouse.click(target.x, target.y, { delay: 50 });
  await page.waitForTimeout(WAIT_MS).catch(() => {});
  console.log(JSON.stringify({ stage: 'clicked', label: 'accounts_center', text: target.text, href: sanitizedUrl(target.href), x: target.x, y: target.y }));
  return target;
}
