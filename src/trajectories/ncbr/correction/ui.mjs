import { normalize } from './plan.mjs';
import { humanIdlePause } from '../../../../dist/human/mouse.js';

const forbidden = /^(prześlij do oceny|złóż|wyślij(?:\s+poprawiony)?\s+wniosek|wyślij\s+korektę|podpisz\s+i\s+wyślij|zatwierdź\s+i\s+wyślij)/i;

export async function gotoSafe(page, url, projectUrl) {
  if (url !== projectUrl && !url.startsWith(`${projectUrl}/`)) throw new Error(`Navigation outside project: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  if (!page.url().startsWith(projectUrl)) throw new Error(`Unexpected page: ${page.url()}`);
  await page.evaluate((pattern) => {
    document.addEventListener('click', (event) => {
      const element = event.target instanceof Element ? event.target.closest('button, a, [role="button"], [role="menuitem"]') : null;
      if (element && new RegExp(pattern, 'i').test(element.textContent.trim())) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  }, forbidden.source);
}

export async function clickSafe(locator, label) {
  if (forbidden.test(label)) throw new Error(`Refusing submission control: ${label}`);
  await locator.waitFor({ state: 'visible' });
  await locator.page().waitForFunction((element) => element.isConnected && !element.disabled, await locator.elementHandle());
  await locator.dispatchEvent('click');
  await humanIdlePause('short');
}

export async function identity(page, projectUrl, project) {
  await gotoSafe(page, projectUrl, projectUrl);
  const body = normalize(await page.locator('body').innerText());
  const status = project.allowedStatusNeedles.find((value) => body.includes(value));
  if (!body.includes(project.applicationNumber) || !body.includes(project.titleNeedle) || !status) {
    throw new Error('Application UUID, number, title or correction status does not match the plan');
  }
  return { projectId: project.id, applicationNumber: project.applicationNumber, status };
}

export async function openRow(page, collection, row, projectUrl) {
  await gotoSafe(page, collection.url, projectUrl);
  const rows = page.locator('table tbody tr').filter({ hasText: row.rowNeedle })
    .filter({ has: page.locator('button[aria-label="overflow-options"]') });
  await rows.first().waitFor({ state: 'visible' });
  if (await rows.count() !== 1) throw new Error(`${collection.label}: row is not unique: ${row.rowNeedle}`);
  await clickSafe(rows.locator('button[aria-label="overflow-options"]'), 'row menu');
  await clickSafe(page.getByRole('menuitem', { name: 'Edytuj', exact: true }).filter({ visible: true }), 'Edytuj');
  await page.waitForFunction(({ suffix, expected, equals }) => {
    const matches = Array.from(document.querySelectorAll('[name]')).filter((element) => element.name.endsWith(suffix));
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    return matches.some((element) => equals ? norm(element.value) === norm(expected) : norm(element.value).includes(norm(expected)));
  }, { suffix: row.matchField, expected: row.matchNeedle, equals: row.matchMode === 'equals' });
  await humanIdlePause('short');
}

export async function closeDrawer(page) {
  const close = page.getByRole('button', { name: 'close side drawer', exact: true }).filter({ visible: true });
  if (await close.count()) await clickSafe(close.last(), 'close side drawer');
}

export async function save(page, collection = false) {
  const selector = collection ? '#collection-obj-form-save-btn' : '#section-form-save-btn';
  const button = page.locator(selector).filter({ visible: true });
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => candidate.request().method() !== 'GET' && candidate.url().includes('/api/beneficiary/')),
    clickSafe(button, 'Zapisz'),
  ]);
  if (!response.ok()) throw new Error(`Save rejected: ${response.status()} ${await response.text()}`);
  await page.getByText('Zapisano dane', { exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction((selector) => {
    const element = document.querySelector(selector);
    return !element || element.disabled || !element.getClientRects().length;
  }, selector);
  if (collection) {
    await closeDrawer(page);
    const parent = page.locator('#section-form-save-btn').filter({ visible: true });
    if (await parent.count() && await parent.isEnabled()) {
      await clickSafe(parent, 'Zapisz');
      await humanIdlePause('long');
    }
  }
}
