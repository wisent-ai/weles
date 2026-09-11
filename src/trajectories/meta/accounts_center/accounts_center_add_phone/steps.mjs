// The phone steps: choosing a control by its label, the phone and code fields, and the account chooser.
import { humanClickLocator } from '../../../../../dist/human/mouse.js';
import { humanType } from '../../../../../dist/human/keyboard.js';
import { USER_DATA_DIR, VERIFY_CODE, VERIFY_PHONE, WAIT_MS } from './settings.mjs';
import { sanitize } from './page.mjs';

export async function clickFirst(page, label, allow, deny = /delete|remove|usuń|anuluj|cancel/i) {
  const target = await page.evaluate(({ allowSource, allowFlags, denySource, denyFlags }) => {
    const allowRe = new RegExp(allowSource, allowFlags);
    const denyRe = new RegExp(denySource, denyFlags);
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, [role="menuitem"]'))
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
      .filter((item) => item.text && !item.disabled && allowRe.test(item.text) && !denyRe.test(item.text))
      .sort((a, b) => a.area - b.area);
    return nodes[0] || null;
  }, {
    allowSource: allow.source,
    allowFlags: allow.flags,
    denySource: deny.source,
    denyFlags: deny.flags,
  }).catch(() => null);
  if (!target) return null;
  await page.mouse.click(target.x, target.y, { delay: 50 });
  await page.waitForTimeout(WAIT_MS).catch(() => {});
  console.log(JSON.stringify({ stage: 'clicked', label, text: sanitize(target.text), x: target.x, y: target.y }));
  return target;
}

export async function waitAndClickFirst(page, label, allow, deny, attempts = 8) {
  for (let i = 0; i < attempts; i += 1) {
    const clicked = await clickFirst(page, label, allow, deny);
    if (clicked) return clicked;
    await page.waitForTimeout(1500).catch(() => {});
  }
  return null;
}

export async function fillPhone(page) {
  const input = await page.locator('input[type="tel"], input[placeholder*="phone" i], input[aria-label*="phone" i], input[placeholder*="telefon" i], input[aria-label*="telefon" i], input[type="text"]').filter({ visible: true }).last();
  if (!await input.isVisible().catch(() => false)) return false;
  await humanClickLocator(page, input).catch(() => {});
  await page.keyboard.press('ControlOrMeta+A').catch(() => {});
  await humanType(page, VERIFY_PHONE).catch(async () => {
    await page.keyboard.insertText(VERIFY_PHONE).catch(() => {});
  });
  await page.waitForTimeout(1000).catch(() => {});
  console.log(JSON.stringify({ stage: 'filled_phone', redacted: true }));
  return true;
}

export async function fillCode(page) {
  if (!VERIFY_CODE) return false;
  const input = page.locator('input').filter({ visible: true }).last();
  if (!await input.isVisible().catch(() => false)) return false;
  await humanClickLocator(page, input).catch(() => {});
  await page.keyboard.press('ControlOrMeta+A').catch(() => {});
  await humanType(page, VERIFY_CODE).catch(async () => {
    await page.keyboard.insertText(VERIFY_CODE).catch(() => {});
  });
  await page.waitForTimeout(1000).catch(() => {});
  console.log(JSON.stringify({ stage: 'filled_code', redacted: true }));
  return true;
}

export async function selectPhoneAssociationAccount(page) {
  const target = await page.evaluate(() => {
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], [role="group"], label, div'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: textOf(el),
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          area: rect.width * rect.height,
        };
      })
      .filter((item) => /Wisent Wisent Facebook/i.test(item.text) && item.y > 500 && !item.disabled)
      .sort((a, b) => {
        if (a.role === 'group' && b.role !== 'group') return -1;
        if (b.role === 'group' && a.role !== 'group') return 1;
        return a.area - b.area;
      });
    return candidates[0] || null;
  }).catch(() => null);
  if (!target) return null;
  await page.mouse.click(target.x, target.y, { delay: 50 });
  await page.waitForTimeout(1000).catch(() => {});
  console.log(JSON.stringify({ stage: 'clicked', label: 'select_phone_association_account', text: sanitize(target.text), role: target.role, x: target.x, y: target.y }));
  return target;
}

console.log(JSON.stringify({
  stage: 'start',
  userDataDir: USER_DATA_DIR,
  headless: process.env.META_VERIFY_HEADLESS === '1',
}, null, 2));
