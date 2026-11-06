/**
 * Choose an option in the one combobox the run names, by its accessible
 * name: a native <select> (set by the option whose label is the value, as the
 * browser sets it, no synthetic pointer) or an ARIA combobox (opened and its
 * option of that exact name pressed through the humanized pointer). A target
 * the page does not name, more than one control of that name, or a value the
 * combobox does not offer is refused naming what the page offered; nothing is
 * guessed from class names or substrings.
 */

import { humanClickLocator } from './mouse.js';
import { pageSettled } from '../browser/settled.js';

type Page = any;

/** An accessible name equal to `text` as a whole, letter case aside. */
function wholeName(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
}

/** The one control the page names `target`; none or several is refused. */
async function namedCombobox(page: Page, target: string): Promise<any> {
  const named = page.getByRole('combobox', { name: wholeName(target) });
  const [only, ...others] = await named.all();
  if (only === undefined || others.length) {
    const offered = await page
      .getByRole('combobox')
      .evaluateAll((nodes: Element[]) =>
        nodes.map((node) => node.getAttribute('aria-label') ?? node.id),
      );
    throw new Error(
      `the page names ${others.length ? 'more than one' : 'no'} combobox "${target}"; it shows ${JSON.stringify(offered)}`,
    );
  }
  return only;
}

/** Select `value` in the combobox named `target`, and answer the option chosen. */
export async function selectOption(
  page: Page,
  target: string,
  value: string,
): Promise<string> {
  console.log(`[select] target="${target}" value="${value}"`);
  const combobox = await namedCombobox(page, target);
  const native = await combobox.evaluate(
    (node: Element) => node instanceof HTMLSelectElement,
  );
  if (native) {
    const labels: string[] = await combobox.evaluate(
      (node: HTMLSelectElement) =>
        Array.from(node.options, (option) => option.label),
    );
    const label = labels.find((candidate) => wholeName(value).test(candidate));
    if (label === undefined)
      throw new Error(
        `the select "${target}" offers no option labelled "${value}"; it offers ${JSON.stringify(labels)}`,
      );
    await combobox.selectOption({ label });
    return label;
  }
  await humanClickLocator(page, combobox);
  await pageSettled(page);
  const option = page.getByRole('option', { name: wholeName(value) });
  const [only, ...others] = await option.all();
  if (only === undefined || others.length) {
    const offered = await page
      .getByRole('option')
      .evaluateAll((nodes: Element[]) =>
        nodes.map((node) => node.textContent?.trim()),
      );
    throw new Error(
      `the combobox "${target}" shows ${others.length ? 'more than one' : 'no'} option "${value}"; it shows ${JSON.stringify(offered)}`,
    );
  }
  await humanClickLocator(page, only);
  await pageSettled(page);
  return value;
}
