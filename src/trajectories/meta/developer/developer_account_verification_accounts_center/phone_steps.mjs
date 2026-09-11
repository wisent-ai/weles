// The phone steps: sending the number, updating a stored one, and confirming the code.
import { humanClickLocator } from '../../../../../dist/human/mouse.js';
import { humanFill, humanType } from '../../../../../dist/human/keyboard.js';
import { USER_DATA_DIR, VERIFY_CODE, VERIFY_PHONE, WAIT_MS } from './settings.mjs';
import { phoneNationalNumber, snapshot } from './page.mjs';
import { selectCountryForPhone } from './navigation.mjs';

export async function fillPhoneAndSend(page) {
  if (!VERIFY_PHONE) return { filled: false, clicked: false };
  const countryChanged = await selectCountryForPhone(page, VERIFY_PHONE);
  if (countryChanged) {
    await snapshot(page, 'after_country_select');
  }
  const input = page.locator('input[placeholder*="phone" i], input[aria-label*="phone" i], input[placeholder*="mobile" i], input[aria-label*="mobile" i], input[type="tel"]').filter({ visible: true }).last();
  if (!await input.isVisible().catch(() => false)) return { filled: false, clicked: false };
  const inputValue = phoneNationalNumber(VERIFY_PHONE) || VERIFY_PHONE;
  const rect = await input.boundingBox().catch(() => null);
  if (rect) await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2, { delay: 50 }).catch(() => {});
  await input.focus().catch(() => {});
  await page.keyboard.press('ControlOrMeta+A').catch(() => {});
  await humanType(page, inputValue).catch(async () => {
    await humanFill(page, input, inputValue).catch(() => {});
  });
  await input.dispatchEvent('input').catch(() => {});
  await input.dispatchEvent('change').catch(() => {});
  await page.waitForTimeout(1000).catch(() => {});
  let inputState = await input.evaluate((el) => {
    const digits = (el.value || '').replace(/\D/g, '');
    return {
      valueLength: digits.length,
      valueSuffix: digits.slice(-2),
      placeholder: el.getAttribute('placeholder') || '',
      type: el.getAttribute('type') || '',
      maxLength: el.maxLength,
    };
  }).catch(() => ({ valueLength: null, valueSuffix: null, placeholder: '', type: '', maxLength: null }));
  if (inputState.valueLength === 0) {
    await input.evaluate((el, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, inputValue).catch(() => {});
    await page.waitForTimeout(1000).catch(() => {});
    inputState = await input.evaluate((el) => {
      const digits = (el.value || '').replace(/\D/g, '');
      return {
        valueLength: digits.length,
        valueSuffix: digits.slice(-2),
        placeholder: el.getAttribute('placeholder') || '',
        type: el.getAttribute('type') || '',
        maxLength: el.maxLength,
      };
    }).catch(() => ({ valueLength: null, valueSuffix: null, placeholder: '', type: '', maxLength: null }));
  }
  console.log(JSON.stringify({
    stage: 'filled_phone_input',
    valueLength: inputState.valueLength,
    valueSuffix: inputState.valueSuffix,
    placeholder: inputState.placeholder,
    type: inputState.type,
    maxLength: inputState.maxLength,
  }));
  const clicked = await page.evaluate(() => {
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: textOf(el),
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      })
      .filter((item) => !item.disabled && /Send Verification SMS/i.test(item.text));
    return candidates[0] || null;
  });
  if (!clicked) return { filled: true, clicked: false };
  await page.mouse.click(clicked.x, clicked.y, { delay: 50 });
  await page.waitForTimeout(WAIT_MS).catch(() => {});
  console.log(JSON.stringify({ stage: 'clicked', label: 'send_verification_sms', text: clicked.text, x: clicked.x, y: clicked.y }));
  return { filled: true, clicked: true };
}

export async function clickUpdateMobileNumber(page) {
  const target = await page.evaluate(() => {
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: textOf(el),
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      })
      .filter((item) => !item.disabled && /Update Mobile Number|Zaktualizuj numer|Zmień numer/i.test(item.text));
    return candidates[0] || null;
  });
  if (!target) return null;
  await page.mouse.click(target.x, target.y, { delay: 50 });
  await page.waitForTimeout(WAIT_MS).catch(() => {});
  console.log(JSON.stringify({ stage: 'clicked', label: 'update_mobile_number', text: target.text, x: target.x, y: target.y }));
  return target;
}

export async function fillCodeAndContinue(page) {
  if (!VERIFY_CODE) return { filled: false, clicked: false };
  const input = page.locator('input').filter({ visible: true }).last();
  if (!await input.isVisible().catch(() => false)) return { filled: false, clicked: false };
  await humanClickLocator(page, input).catch(() => {});
  await page.keyboard.press('ControlOrMeta+A').catch(() => {});
  await humanType(page, VERIFY_CODE).catch(async () => {
    await page.keyboard.insertText(VERIFY_CODE).catch(() => {});
  });
  await page.waitForTimeout(1000).catch(() => {});
  const clicked = await page.evaluate(() => {
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: textOf(el),
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      })
      .filter((item) => !item.disabled && /^(Continue|Kontynuuj|Dalej)$/i.test(item.text));
    return candidates[0] || null;
  });
  if (!clicked) return { filled: true, clicked: false };
  await page.mouse.click(clicked.x, clicked.y, { delay: 50 });
  await page.waitForTimeout(WAIT_MS).catch(() => {});
  console.log(JSON.stringify({ stage: 'clicked', label: 'developer_code_continue', text: clicked.text, x: clicked.x, y: clicked.y }));
  return { filled: true, clicked: true };
}

console.log(JSON.stringify({
  stage: 'start',
  userDataDir: USER_DATA_DIR,
  headless: process.env.META_VERIFY_HEADLESS === '1',
}, null, 2));
