// Read-only deep text-ending audit for the replacement NCBR LSI draft.
// Opens existing collection rows with Edytuj, reads fields, then Anuluj.
// Never writes, saves, submits, uploads, or deletes.

import { chromium } from 'playwright';
import {
  humanClickLocator,
  humanIdlePause,
} from '../../../../../dist/human/mouse.js';

const endpoint = (await import('#ncbr-settings')).cdpEndpoint();
const projectId = (await import('#ncbr-settings')).projectId();
const projectUrl = ['https://', `lsi2.ncbr.gov.pl/projekt/${projectId}`].join(
  '',
);
const fast = Boolean(process.env.FAST);
const scopeMode = process.env.SCOPE || 'all';

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2));
  process.exit(1);
}

const fallbackSections = [
  ['1.1', (await import('#ncbr-settings')).sectionId('1_1')],
  ['1.2', (await import('#ncbr-settings')).sectionId('1_2')],
  ['1.3', (await import('#ncbr-settings')).sectionId('1_3')],
  ['1.4', (await import('#ncbr-settings')).sectionId('1_4')],
  ['1.5', (await import('#ncbr-settings')).sectionId('1_5')],
  ['2.1', (await import('#ncbr-settings')).sectionId('2_1')],
  ['2.2', (await import('#ncbr-settings')).sectionId('2_2')],
  ['2.3', (await import('#ncbr-settings')).sectionId('2_3')],
  ['2.4', (await import('#ncbr-settings')).sectionId('2_4')],
  ['3.1', (await import('#ncbr-settings')).sectionId('3_1')],
  ['3.2', (await import('#ncbr-settings')).sectionId('3_2')],
  ['3.3', (await import('#ncbr-settings')).sectionId('3_3')],
  ['3.4', (await import('#ncbr-settings')).sectionId('3_4')],
  ['3.5', (await import('#ncbr-settings')).sectionId('3_5')],
  ['4.1', (await import('#ncbr-settings')).sectionId('4_1')],
  ['4.2', (await import('#ncbr-settings')).sectionId('4_2')],
  ['4.3', (await import('#ncbr-settings')).sectionId('4_3')],
  ['5.1', (await import('#ncbr-settings')).sectionId('5_1')],
  ['5.2', (await import('#ncbr-settings')).sectionId('5_2')],
  ['5.3', (await import('#ncbr-settings')).sectionId('5_3')],
  ['5.4', (await import('#ncbr-settings')).sectionId('5_4')],
  ['6.1', (await import('#ncbr-settings')).sectionId('6_1')],
  ['6.3', (await import('#ncbr-settings')).sectionId('6_3')],
  ['6.5', (await import('#ncbr-settings')).sectionId('6_5')],
  ['8', (await import('#ncbr-settings')).sectionId('8')],
  ['9.1', (await import('#ncbr-settings')).sectionId('9_1')],
  ['9.2', (await import('#ncbr-settings')).sectionId('9_2')],
  ['10.1', (await import('#ncbr-settings')).sectionId('10_1')],
  ['10.2', (await import('#ncbr-settings')).sectionId('10_2')],
  ['10.3', (await import('#ncbr-settings')).sectionId('10_3')],
  ['10.4', (await import('#ncbr-settings')).sectionId('10_4')],
].map(([label, id]) => ({ label, url: `${projectUrl}/projekt_step/${id}` }));

function sleepKind() {
  return fast ? 'short' : 'long';
}

async function pause(kind = sleepKind()) {
  await humanIdlePause(kind);
}

async function waitForSectionShell() {
  await page.waitForSelector('textarea, input, table, button'); // allow-raw-playwright: wait for rendered section controls before read-only scan
}

function cleanText(v) {
  return String(v || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyField(f) {
  const value = cleanText(f.value);
  if (value.length < 80) return null;
  const name = `${f.name} ${f.label}`.toLowerCase();
  if (
    /nip|regon|krs|numer|kwota|koszt|wartosc|wartość|rok|data|email|telefon|kod|adres|ulica|gmina|powiat|wojew|miejscow|nazwa_skrocona/.test(
      name,
    )
  )
    return null;
  if (/radio|checkbox|combobox/.test(f.role || '')) return null;
  const max = Number(f.max) || null;
  const near = Boolean(
    max && (value.length >= max - 25 || value.length / max >= 0.97),
  );
  const noSentenceEnd = !/[.!?…:;)"”\]]$/.test(value);
  const dangling =
    /\b(?:i|oraz|z|ze|w|we|na|do|dla|przez|które|który|która|aby|lub|or|and|AI)$/i.test(
      value,
    );
  const artifact = /(\*\*|^#{1,6}\s|\(limit\s*\d|<!--|\|---)/im.test(value);
  if (!near && !noSentenceEnd && !dangling && !artifact) return null;
  return {
    ...f,
    value,
    len: value.length,
    max,
    near,
    noSentenceEnd,
    dangling,
    artifact,
  };
}

async function fieldDump(scope) {
  return page.evaluate((scope) => {
    const labelFor = (el) => {
      if (el.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab) return lab.textContent.trim();
      }
      // The nearest label within the field's own group; a label above the first
      // ancestor holding another field names that field, not this one.
      for (let node = el.parentElement; node; node = node.parentElement) {
        const lab = node.querySelector('label, .MuiFormLabel-root, legend');
        if (lab?.textContent) return lab.textContent.trim();
        if (
          Array.from(node.querySelectorAll('input, textarea, select')).some(
            (f) => f !== el,
          )
        )
          break;
      }
      return '';
    };
    return Array.from(document.querySelectorAll('textarea, input'))
      .map((el) => ({
        scope,
        tag: el.tagName,
        type: el.getAttribute('type') || '',
        role: el.getAttribute('role') || '',
        name: el.getAttribute('name') || '',
        label: labelFor(el),
        value: el.value || '',
        max: el.getAttribute('maxlength') || '',
        readOnly: el.readOnly,
        disabled: el.disabled,
      }))
      .filter(
        (f) => f.name && f.value && f.name !== 'table_search' && !f.disabled,
      );
  }, scope); // allow-raw-playwright: read-only field dump
}

async function rowCount() {
  return page.evaluate(
    () =>
      Array.from(document.querySelectorAll('table tbody tr')).filter((r) =>
        r.querySelector('button[aria-label="overflow-options"]'),
      ).length,
  );
}

async function openRow(index) {
  const rows = page
    .locator('table tbody tr')
    .filter({ has: page.locator('button[aria-label="overflow-options"]') });
  const btn = rows
    .nth(index)
    .locator('button[aria-label="overflow-options"]')
    .first();
  const ok = (await btn.count()) > 0;
  if (ok) await humanClickLocator(page, btn);
  if (!ok) return false;
  await pause('deliberate');
  const hasEdit = await page
    .getByRole('menuitem', { name: 'Edytuj', exact: true })
    .first()
    .count();
  if (!hasEdit) {
    await page.keyboard.press('Escape'); // allow-raw-playwright: close menu after read-only check
    await pause('short');
    return false;
  }
  await page
    .getByRole('menuitem', { name: 'Edytuj', exact: true })
    .first()
    .dispatchEvent('click'); // allow-raw-playwright: open existing row for read-only value inspection
  await pause(sleepKind());
  return true;
}

async function cancelOpenForm() {
  const buttons = page
    .getByRole('button', { name: 'Anuluj', exact: true })
    .filter({ visible: true });
  const count = await buttons.count();
  if (count) await humanClickLocator(page, buttons.nth(count - 1));
  await pause(sleepKind());
}

const sections = fallbackSections;
const findings = [];
const sectionStats = [];

for (const section of sections) {
  if (process.env.SECTION && process.env.SECTION !== section.label) continue;
  try {
    await page.goto(section.url, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: read-only section navigation
    await waitForSectionShell();
    await pause(sleepKind());
    await page.evaluate(() => {
      const banner = Array.from(document.querySelectorAll('div')).find((d) =>
        (d.innerText || '').includes('pliki cookies'),
      );
      if (banner) banner.style.pointerEvents = 'none';
    }); // allow-raw-playwright: neutralise cookie banner only
    const visible = await fieldDump(`${section.label}:visible`);
    for (const f of visible) {
      const hit = classifyField(f);
      if (hit) findings.push(hit);
    }
    const count = await rowCount();
    let opened = 0;
    if (scopeMode === 'visible') {
      sectionStats.push({
        section: section.label,
        visibleFields: visible.length,
        rows: count,
        inspectedRows: 0,
      });
      continue;
    }
    for (let i = 0; i < count; i += 1) {
      await page.goto(section.url, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: reset section before opening next row
      await waitForSectionShell();
      await pause(sleepKind());
      const didOpen = await openRow(i);
      if (!didOpen) continue;
      opened += 1;
      const rowFields = await fieldDump(`${section.label}:row:${i + 1}`);
      for (const f of rowFields) {
        const hit = classifyField(f);
        if (hit) findings.push(hit);
      }
      await cancelOpenForm();
    }
    sectionStats.push({
      section: section.label,
      visibleFields: visible.length,
      rows: count,
      inspectedRows: opened,
    });
  } catch (e) {
    sectionStats.push({
      section: section.label,
      error: String(e?.message || e),
    });
  }
}

console.log(
  JSON.stringify(
    {
      projectId,
      scannedSections: sectionStats,
      findingCount: findings.length,
      findings,
    },
    null,
    2,
  ),
);
process.exit(0);
