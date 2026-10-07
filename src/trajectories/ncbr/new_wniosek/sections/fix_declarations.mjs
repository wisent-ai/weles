// Fill required declaration controls in Dokumenty/oswiadczenia. UI-only; never submits.

import { chromium } from 'playwright';
import {
  humanClickLocator,
  humanIdlePause,
} from '../../../../../dist/human/mouse.js';

const endpoint = (await import('#ncbr-settings')).cdpEndpoint();
const SECTION_URL = (await import('#ncbr-settings')).sectionUrl('DECLARATIONS');
const REQUIRED = [
  'oswiadczenie_klauzula_informacyjna',
  'oswiadczenie_odpowiedzialnosci_karnej',
  'oswiadczenie_zapoznania_z_regulaminem',
  'oswiadczenie_zobowiazanie_do_udzialu_w_ankietach',
  'oswiadczenie_udostepnienia_miejsca_realizacji_projektu',
];

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }));
  process.exit(1);
}

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('div')).find((d) =>
    (d.innerText || '').includes('pliki cookies'),
  );
  if (b) b.style.pointerEvents = 'none';
}); // allow-raw-playwright: neutralise cookie banner

function dumpExpr(names) {
  return Array.from(document.querySelectorAll('input'))
    .map((input) => {
      const label = input.id
        ? document
            .querySelector(`label[for="${CSS.escape(input.id)}"]`)
            ?.textContent?.trim()
        : null;
      const wrap = input.closest(
        'label, .MuiFormControlLabel-root, .MuiFormGroup-root, .MuiBox-root, .MuiFormControl-root',
      );
      return {
        type: input.type,
        name: input.name || null,
        value: input.value,
        checked: input.checked,
        requiredTarget: names.some((n) => (input.name || '').endsWith(n)),
        label,
        nearby: wrap ? wrap.textContent.trim() : null,
      };
    })
    .filter((x) => x.name || x.label || x.nearby);
}

if (process.env.DIAG) {
  const out = await page.evaluate(dumpExpr, REQUIRED);
  const buttons = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button'))
      .map((b) => ({ text: b.innerText.trim(), disabled: b.disabled }))
      .filter((b) => b.text),
  );
  console.log(JSON.stringify({ inputs: out, buttons }, null, 2));
  process.exit(0);
}

const clicked = [];
for (const suffix of REQUIRED) {
  const candidates = page.locator(`input[name$="${suffix}"]`);
  const count = await candidates.count();
  let target = null;
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (
      ['true', 'Tak', 'tak', '1', 'on'].includes(await candidate.inputValue())
    ) {
      target = candidate;
      break;
    }
  }
  target ??= count > 0 ? candidates.first() : null;
  if (!target) {
    clicked.push({ suffix, status: 'missing' });
    continue;
  }
  if (!(await target.isChecked())) await humanClickLocator(page, target);
  clicked.push({
    suffix,
    type: await target.getAttribute('type'),
    value: await target.inputValue(),
    checked: await target.isChecked(),
  });
}
await humanIdlePause('deliberate');

let saveResult = 'saved';
try {
  const save = page
    .locator('button:not([disabled])')
    .filter({ hasText: /^Zapisz$/ })
    .filter({ visible: true })
    .last();
  if ((await save.count()) === 0) throw new Error('no enabled Zapisz');
  await humanClickLocator(page, save);
  await humanIdlePause('long');
} catch (e) {
  saveResult = `NOT SAVED: ${String(e?.message || e)}`;
}

const readback = await page.evaluate(dumpExpr, REQUIRED);
console.log(
  JSON.stringify(
    { saveResult, clicked, readback: readback.filter((x) => x.requiredTarget) },
    null,
    2,
  ),
);
process.exit(0);
