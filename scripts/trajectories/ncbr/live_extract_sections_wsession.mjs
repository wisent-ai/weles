// Safe live extractor for the replacement NCBR STEP B draft via Weles WSession.
// Logs in from env vars, removes password from env before session start, reads sections only.

import { writeFileSync } from 'node:fs';
import { WSession } from '../../../dist/index.js';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const PROJECT_ID = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const PROJECT_URL = process.env.NCBR_PROJECT_URL || `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}`;
const OUT = process.env.OUT || '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/live_lsi_readback_2026-06-24.json';
const email = process.env.NCBR_EMAIL;
const password = process.env.NCBR_PASSWORD;

if (!email || !password) {
  console.log(JSON.stringify({ error: 'MISSING_NCBR_CREDENTIALS' }, null, 2));
  process.exit(2);
}
delete process.env.NCBR_PASSWORD;

const known = [
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
  ['7', '77be8643-1e31-4619-b266-d156a5388cf6'],
  ['8', 'd31b6d68-33b7-45a0-a032-0f5f02b5aed8'],
  ['9.1', '8ff0ee28-01e7-4a83-96c0-e11049be2c70'],
  ['9.2', 'e95d0c23-8a39-4d56-96fa-ace3e4f0d23a'],
  ['10.1', 'e5bd23d7-9d4d-4f2e-948a-97c95041ef18'],
  ['10.2', '51455d27-6e3d-4629-9cc6-2a124f5432c8'],
  ['10.3', '256ac98a-bb3c-4715-ad13-e8dbcd3f94f4'],
  ['10.4', '4e260fae-c455-41ce-bba3-d0df2a8767fd'],
].map(([label, id]) => ({ label, url: `${PROJECT_URL}/projekt_step/${id}`, source: 'known' }));

async function setReactInputValue(locator, value) {
  await locator.waitFor({ state: 'visible' });
  await locator.evaluate((el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (!setter) throw new Error('native value setter not found');
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value); // allow-raw-playwright: set controlled React/MUI login input inside Weles session
  await humanIdlePause('short');
}

function uniqueSections(uiUrls) {
  const byUrl = new Map();
  for (const item of [...uiUrls, ...known]) {
    if (!item.url.includes('/projekt_step/')) continue;
    const id = item.url.split('/projekt_step/')[1]?.split(/[?#]/)[0];
    if (!id) continue;
    if (!byUrl.has(id)) byUrl.set(id, { ...item, id });
  }
  return Array.from(byUrl.values()).sort((a, b) => {
    const ka = Number(String(a.label || '').match(/^\d+(?:\.\d+)?/)?.[0] || 99);
    const kb = Number(String(b.label || '').match(/^\d+(?:\.\d+)?/)?.[0] || 99);
    return ka - kb || String(a.label || a.id).localeCompare(String(b.label || b.id));
  });
}

const session = await WSession.start({ label: 'ncbr_live_extract_sections_wsession', proxy: 'direct', browser: 'chromium' });
const page = session.page;
page.setDefaultTimeout(30000);

await page.goto('https://lsi2.ncbr.gov.pl/logowanie', { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: Weles-controlled LSI login navigation
await humanIdlePause('long');
await setReactInputValue(page.locator('#mail, input[name="mail"]').first(), email);
await setReactInputValue(page.locator('#password, input[name="password"]').first(), password);
await page.evaluate(() => {
  const input = document.querySelector('#isStatuteAccepted, input[name="isStatuteAccepted"]');
  if (!input || input.checked) return;
  const target = input.closest('label') || input.closest('.MuiFormControlLabel-root') || input.closest('.MuiCheckbox-root') || input;
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  if (!input.checked) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set?.call(input, true);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
}); // allow-raw-playwright: accept visible statute checkbox to log in only
await humanIdlePause('short');
await page.waitForFunction(() => {
  const btn = document.querySelector('#login-btn') || Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Zaloguj');
  return !!btn && !btn.disabled;
}, null, { timeout: 10000 }).catch(() => null); // allow-raw-playwright: wait for MUI login validation
for (let attempt = 1; attempt <= 3 && page.url().includes('/logowanie'); attempt += 1) {
  if (attempt === 1) {
    await page.locator('#login-btn, button:has-text("Zaloguj")').first().click({ force: true }); // allow-raw-playwright: submit visible login form only
  } else {
    await page.evaluate(() => {
      const btn = document.querySelector('#login-btn') || Array.from(document.querySelectorAll('button')).find((b) => b.innerText.includes('Zaloguj'));
      if (!btn) throw new Error('login button not found for retry');
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }); // allow-raw-playwright: retry visible login button dispatch
  }
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
  await humanIdlePause('long');
}
if (page.url().includes('/logowanie')) throw new Error('login stayed on login page');

await page.goto(PROJECT_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: read-only project navigation
await humanIdlePause('long');

const status = await page.evaluate(() => {
  const body = document.body?.innerText || '';
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  return {
    url: location.href,
    title: document.title,
    statusLines: lines.filter((l) => /W przygotowaniu|Złożony|Zlozony|Wycofany|Konkurs:|nabór|nabor/i.test(l)).slice(0, 20),
    submitButtons: Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Złóż wniosek').map((b) => ({ disabled: b.disabled })),
  };
}); // allow-raw-playwright: read project status only

const uiUrls = await page.evaluate(() => {
  const out = [];
  for (const a of document.querySelectorAll('a[href*="/projekt_step/"], [href*="/projekt_step/"]')) {
    const href = a.href || a.getAttribute('href');
    const text = (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160);
    if (href) out.push({ label: text, url: new URL(href, location.href).href, source: 'ui' });
  }
  return out;
}); // allow-raw-playwright: discover visible section URLs from UI

const only = process.env.ONLY ? new Set(process.env.ONLY.split(',').map((x) => x.trim()).filter(Boolean)) : null;
const sections = uniqueSections(uiUrls).filter((section) => !only || only.has(String(section.label)) || only.has(String(section.id)));
const extracted = [];

function writeSnapshot(partial) {
  const summary = {
    generatedAt: new Date().toISOString(),
    partial,
    projectId: PROJECT_ID,
    projectUrl: PROJECT_URL,
    status,
    discoveredUiSections: uiUrls.length,
    plannedSections: sections.length,
    extractedSections: extracted.length,
    fieldCount: extracted.reduce((sum, s) => sum + s.fields.length, 0),
    tableCount: extracted.reduce((sum, s) => sum + s.tables.length, 0),
    sections: extracted.map((s) => ({
      label: s.label,
      id: s.id,
      source: s.source,
      finalUrl: s.finalUrl,
      fields: s.fields.length,
      tables: s.tables.map((t) => t.rows),
    })),
  };
  writeFileSync(OUT, JSON.stringify({ summary, sections: extracted }, null, 2));
  return summary;
}

for (let i = 0; i < sections.length; i += 1) {
  const section = sections[i];
  console.log(`[extract] ${i + 1}/${sections.length} ${section.label || section.id}`);
  await page.goto(section.url, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: read-only section navigation
  await page.waitForSelector('input, textarea, table, button', { timeout: 6000 }).catch(() => null); // allow-raw-playwright: wait for section controls before readback
  await humanIdlePause('deliberate');
  const data = await page.evaluate((sectionMeta) => {
    function labelFor(el) {
      if (el.getAttribute?.('aria-label')) return el.getAttribute('aria-label');
      if (el.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab) return lab.textContent.trim();
      }
      let node = el;
      for (let i = 0; i < 7 && node; i += 1) {
        node = node.parentElement;
        const lab = node?.querySelector?.('label, .MuiFormLabel-root, legend');
        if (lab?.textContent) return lab.textContent.trim().replace(/\s+/g, ' ').slice(0, 200);
      }
      return null;
    }
    const fields = [];
    for (const el of document.querySelectorAll('input, textarea, select')) {
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type') || null;
      const name = el.getAttribute('name') || null;
      if (name === 'table_search') continue;
      const value = 'value' in el ? String(el.value || '') : '';
      fields.push({
        tag,
        type,
        name,
        id: el.id || null,
        label: labelFor(el),
        role: el.getAttribute('role'),
        max: el.getAttribute('maxlength'),
        checked: type === 'radio' || type === 'checkbox' ? Boolean(el.checked) : null,
        value,
        valueLength: value.length,
        ariaInvalid: el.getAttribute('aria-invalid'),
        disabled: Boolean(el.disabled),
        readOnly: Boolean(el.readOnly),
      });
    }
    const muiValues = Array.from(document.querySelectorAll('[role="combobox"], .MuiSelect-select')).map((el) => ({
      text: (el.textContent || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 240),
      label: labelFor(el),
      ariaExpanded: el.getAttribute('aria-expanded'),
    })).filter((x) => x.text || x.label);
    const tables = Array.from(document.querySelectorAll('table')).map((table) => ({
      rows: table.querySelectorAll('tbody tr').length,
      headers: Array.from(table.querySelectorAll('th')).map((th) => th.textContent.trim().replace(/\s+/g, ' ')),
      text: table.innerText.replace(/\s+/g, ' ').trim(),
    }));
    const body = document.body?.innerText || '';
    return {
      ...sectionMeta,
      finalUrl: location.href,
      title: document.title,
      headingLines: body.split('\n').map((l) => l.trim()).filter((l) => /^\d+(?:\.\d+)?\./.test(l)).slice(0, 8),
      fields,
      muiValues,
      tables,
      buttons: Array.from(document.querySelectorAll('button')).map((b) => ({ text: b.innerText.trim(), disabled: b.disabled })).filter((b) => b.text),
      bodyHead: body.slice(0, 1800),
      bodyTail: body.slice(-1800),
    };
  }, section); // allow-raw-playwright: extract read-only DOM state
  extracted.push(data);
  writeSnapshot(true);
}

const summary = writeSnapshot(false);
console.log(JSON.stringify({ out: OUT, ...summary }, null, 2));
await session.ctx.close();
process.exit(0);
