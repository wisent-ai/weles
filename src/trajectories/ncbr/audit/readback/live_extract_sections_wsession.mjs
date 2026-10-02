// Safe live extractor for the replacement NCBR STEP B draft via Weles WSession.
// Logs in from env vars, removes password from env before session start, reads sections only.

import { writeFileSync } from 'node:fs';
import { WSession } from '../../../../../dist/index.js';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../dist/human/keyboard.js';

const PROJECT_ID = (await import('#ncbr-settings')).projectId();
const PROJECT_URL = (await import('#ncbr-settings')).projectUrl();
const OUT = process.env.OUT || (await import('#ncbr-settings')).applicationFile('live_lsi_readback.json');
const email = process.env.NCBR_EMAIL;
const password = process.env.NCBR_PASSWORD;

if (!email || !password) {
  console.log(JSON.stringify({ error: 'MISSING_NCBR_CREDENTIALS' }, null, 2));
  process.exit(2);
}
delete process.env.NCBR_PASSWORD;

const known = [
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
  ['7', (await import('#ncbr-settings')).sectionId('7')],
  ['8', (await import('#ncbr-settings')).sectionId('8')],
  ['9.1', (await import('#ncbr-settings')).sectionId('9_1')],
  ['9.2', (await import('#ncbr-settings')).sectionId('9_2')],
  ['10.1', (await import('#ncbr-settings')).sectionId('10_1')],
  ['10.2', (await import('#ncbr-settings')).sectionId('10_2')],
  ['10.3', (await import('#ncbr-settings')).sectionId('10_3')],
  ['10.4', (await import('#ncbr-settings')).sectionId('10_4')],
].map(([label, id]) => ({ label, url: `${PROJECT_URL}/projekt_step/${id}`, source: 'known' }));

async function setReactInputValue(locator, value) {
  await locator.waitFor({ state: 'visible' });
  await humanFill(page, locator, value);
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


await page.goto('https://lsi2.ncbr.gov.pl/logowanie', { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: Weles-controlled LSI login navigation
await setReactInputValue(page.locator('#mail, input[name="mail"]').first(), email);
await setReactInputValue(page.locator('#password, input[name="password"]').first(), password);
const statute = page.locator('#isStatuteAccepted, input[name="isStatuteAccepted"]').first();
if (await statute.count() > 0 && !await statute.isChecked()) {
  const statuteLabel = page.locator('label, .MuiFormControlLabel-root, .MuiCheckbox-root')
    .filter({ has: statute }).filter({ visible: true }).first();
  await humanClickLocator(page, await statuteLabel.count() > 0 ? statuteLabel : statute);
}
await page.waitForFunction(() => {
  const btn = document.querySelector('#login-btn') || Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Zaloguj');
  return !!btn && !btn.disabled;
}, null, { polling: 'raf' }); // allow-raw-playwright: wait for MUI login validation
for (let attempt = 1; attempt <= 3 && page.url().includes('/logowanie'); attempt += 1) {
  const loginButton = page.locator('#login-btn, button:has-text("Zaloguj")').filter({ visible: true }).first();
  if (await loginButton.count() === 0) throw new Error('login button not found for retry');
  await humanClickLocator(page, loginButton);
  await page.waitForLoadState('load');
  await humanIdlePause('long');
}
if (page.url().includes('/logowanie')) throw new Error('login stayed on login page');

await page.goto(PROJECT_URL, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: read-only project navigation
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
    const text = (a.textContent || '').trim().replace(/\s+/g, ' ');
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
  await page.goto(section.url, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: read-only section navigation
  await page.waitForSelector('input, textarea, table, button'); // allow-raw-playwright: wait for section controls before readback
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
        if (lab?.textContent) return lab.textContent.trim().replace(/\s+/g, ' ');
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
      text: (el.textContent || el.value || '').trim().replace(/\s+/g, ' '),
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
      body,
    };
  }, section); // allow-raw-playwright: extract read-only DOM state
  extracted.push(data);
  writeSnapshot(true);
}

const summary = writeSnapshot(false);
console.log(JSON.stringify({ out: OUT, ...summary }, null, 2));
await session.ctx.close();
process.exit(0);
