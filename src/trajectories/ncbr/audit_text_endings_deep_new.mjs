// Read-only deep text-ending audit for the replacement NCBR LSI draft.
// Opens existing collection rows with Edytuj, reads fields, then Anuluj.
// Never writes, saves, submits, uploads, or deletes.

import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || ['ht', 'tp://127.0.0.1:9223'].join('');
const projectId = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const projectUrl = ['https://', `lsi2.ncbr.gov.pl/projekt/${projectId}`].join('');
const fast = Boolean(process.env.FAST);
const maxRowsPerSection = Number(process.env.MAX_ROWS || 80);
const scopeMode = process.env.SCOPE || 'all';

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2));
  process.exit(1);
}
page.setDefaultTimeout(30000);

const fallbackSections = [
  ['1.1', '71acd162-e35d-4aff-88a6-ea2fe179a259'],
  ['1.2', '0ca77e3d-373e-464f-9e9d-a35f5193864d'],
  ['1.3', '317a21dd-e798-4115-ab53-6ab5a2912fb0'],
  ['1.4', '4a6e9d5d-10e7-4436-8fd8-728a8e8b8ddc'],
  ['1.5', '3b7656d2-f2d7-44df-af43-4f4b58b4101f'],
  ['2.1', 'c048ab30-3dda-4228-bf71-4ec6904cffda'],
  ['2.2', '80ebca16-a9dd-4798-a334-5ac007cecbf7'],
  ['2.3', 'c5dbdc83-5baf-4866-b3d8-4da3ae553865'],
  ['2.4', '94fb1adb-38a5-4949-b4c1-b0a79472bfd3'],
  ['3.1', '574f07ed-d631-4536-bfd0-e1f7e469415c'],
  ['3.2', '06a70163-2dcc-47a0-b64b-201656946538'],
  ['3.3', 'bb231ac1-d863-41a8-89a7-88c1db3a1bd7'],
  ['3.4', '836f13ca-f474-4d5c-8388-6afd84eaf353'],
  ['3.5', '41b2184d-76e9-4b79-8ece-b2e227dc471f'],
  ['4.1', '5af236aa-03b2-4650-b5a2-95c299dfeeaf'],
  ['4.2', '95a9b43d-b789-479a-a60d-159b975af74d'],
  ['4.3', 'e8020b59-7947-4c3d-9851-0fc499f42427'],
  ['5.1', '557f18a2-ec63-44bf-a429-88dfde7444e4'],
  ['5.2', '01ba2656-83fd-44d0-8908-bb31034018b0'],
  ['5.3', '72d09821-7019-4ac0-ab4f-09fdd4883fc2'],
  ['5.4', 'e635f786-a34c-4a29-b142-4f4081401a5c'],
  ['6.1', '566c735c-8ad0-406f-a948-f3ea921c2cc7'],
  ['6.3', 'fb417879-403e-4241-a202-ec23c6a6b866'],
  ['6.5', 'bdb2c7b3-92d9-4778-9ecc-b4c5bda7d32b'],
  ['8', 'd31b6d68-33b7-45a0-a032-0f5f02b5aed8'],
  ['9.1', '8ff0ee28-01e7-4a83-96c0-e11049be2c70'],
  ['9.2', 'e95d0c23-8a39-4d56-96fa-ace3e4f0d23a'],
  ['10.1', 'e5bd23d7-9d4d-4f2e-948a-97c95041ef18'],
  ['10.2', '51455d27-6e3d-4629-9cc6-2a124f5432c8'],
  ['10.3', '256ac98a-bb3c-4715-ad13-e8dbcd3f94f4'],
  ['10.4', '4e260fae-c455-41ce-bba3-d0df2a8767fd'],
].map(([label, id]) => ({ label, url: `${projectUrl}/projekt_step/${id}` }));

function sleepKind() {
  return fast ? 'short' : 'long';
}

async function pause(kind = sleepKind()) {
  await humanIdlePause(kind);
}

async function waitForSectionShell() {
  await page.waitForSelector('textarea, input, table, button', { timeout: 12000 }).catch(() => {}); // allow-raw-playwright: wait for rendered section controls before read-only scan
}

function cleanText(v) {
  return String(v || '').replace(/\s+/g, ' ').trim();
}

function classifyField(f) {
  const value = cleanText(f.value);
  if (value.length < 80) return null;
  const name = `${f.name} ${f.label}`.toLowerCase();
  if (/nip|regon|krs|numer|kwota|koszt|wartosc|wartość|rok|data|email|telefon|kod|adres|ulica|gmina|powiat|wojew|miejscow|nazwa_skrocona/.test(name)) return null;
  if (/radio|checkbox|combobox/.test(f.role || '')) return null;
  const max = Number(f.max) || null;
  const near = Boolean(max && (value.length >= max - 25 || value.length / max >= 0.97));
  const noSentenceEnd = !/[.!?…:;)"”\]]$/.test(value);
  const dangling = /\b(?:i|oraz|z|ze|w|we|na|do|dla|przez|które|który|która|aby|lub|or|and|AI)$/i.test(value);
  const artifact = /(\*\*|^#{1,6}\s|\(limit\s*\d|<!--|\|---)/im.test(value);
  if (!near && !noSentenceEnd && !dangling && !artifact) return null;
  return {
    ...f,
    value: undefined,
    suffix: value.slice(-360),
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
      let node = el;
      for (let i = 0; i < 7 && node; i += 1) {
        node = node.parentElement;
        const lab = node?.querySelector?.('label, .MuiFormLabel-root, legend');
        if (lab?.textContent) return lab.textContent.trim();
      }
      return '';
    };
    return Array.from(document.querySelectorAll('textarea, input')).map((el) => ({
      scope,
      tag: el.tagName,
      type: el.getAttribute('type') || '',
      role: el.getAttribute('role') || '',
      name: el.getAttribute('name') || '',
      label: labelFor(el).slice(0, 180),
      value: el.value || '',
      max: el.getAttribute('maxlength') || '',
      readOnly: el.readOnly,
      disabled: el.disabled,
    })).filter((f) => f.name && f.value && f.name !== 'table_search' && !f.disabled);
  }, scope); // allow-raw-playwright: read-only field dump
}

async function rowCount() {
  return page.evaluate(() => Array.from(document.querySelectorAll('table tbody tr'))
    .filter((r) => r.querySelector('button[aria-label="overflow-options"]')).length);
}

async function openRow(index) {
  const rows = page.locator('table tbody tr').filter({ has: page.locator('button[aria-label="overflow-options"]') });
  const btn = rows.nth(index).locator('button[aria-label="overflow-options"]').first();
  const ok = await btn.count() > 0;
  if (ok) await humanClickLocator(page, btn);
  if (!ok) return false;
  await pause('deliberate');
  const hasEdit = await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().count();
  if (!hasEdit) {
    await page.keyboard.press('Escape'); // allow-raw-playwright: close menu after read-only check
    await pause('short');
    return false;
  }
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: open existing row for read-only value inspection
  await pause(sleepKind());
  return true;
}

async function cancelOpenForm() {
  const buttons = page.getByRole('button', { name: 'Anuluj', exact: true }).filter({ visible: true });
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
    await page.goto(section.url, { waitUntil: 'domcontentloaded', timeout: 30000 }); // allow-raw-playwright: read-only section navigation
    await waitForSectionShell();
    await pause(sleepKind());
    await page.evaluate(() => {
      const banner = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies'));
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
      sectionStats.push({ section: section.label, visibleFields: visible.length, rows: count, inspectedRows: 0 });
      continue;
    }
    for (let i = 0; i < Math.min(count, maxRowsPerSection); i += 1) {
      await page.goto(section.url, { waitUntil: 'domcontentloaded', timeout: 30000 }); // allow-raw-playwright: reset section before opening next row
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
    sectionStats.push({ section: section.label, visibleFields: visible.length, rows: count, inspectedRows: opened });
  } catch (e) {
    sectionStats.push({ section: section.label, error: String(e?.message || e).slice(0, 240) });
  }
}

console.log(JSON.stringify({
  projectId,
  scannedSections: sectionStats,
  findingCount: findings.length,
  findings,
}, null, 2));
process.exit(0);
