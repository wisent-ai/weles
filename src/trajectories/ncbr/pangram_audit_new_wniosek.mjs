// Read-only Pangram audit for long text answers in the replacement NCBR draft.
// Extracts LSI section text to local files, then optionally runs Pangram.
// Never writes to LSI and never submits the application.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || ['ht', 'tp://127.0.0.1:9223'].join('');
const projectId = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const projectUrl = ['https://', `lsi2.ncbr.gov.pl/projekt/${projectId}`].join('');
const sectionPattern = process.env.SECTION_PATTERN ? new RegExp(process.env.SECTION_PATTERN) : null;
const minChars = Number(process.env.MIN_CHARS || 500);
const maxSections = Number(process.env.MAX_SECTIONS || 999);
const collectOnly = process.env.COLLECT_ONLY === '1';
const includeRows = process.env.INCLUDE_ROWS === '1';
const runId = process.env.WELES_RUN_ID || `ncbr-pangram-${new Date().toISOString().replace(/[:.]/g, '-')}`;
process.env.WELES_RUN_ID = runId;

const sections = [
  ['1.1', 'Informacje ogólne o projekcie', '71acd162-e35d-4aff-88a6-ea2fe179a259'],
  ['1.2', 'Klasyfikacja projektu', '0ca77e3d-373e-464f-9e9d-a35f5193864d'],
  ['1.3', 'Podmioty realizujące projekt', '317a21dd-e798-4115-ab53-6ab5a2912fb0'],
  ['1.4', 'Konkurencja', '4a6e9d5d-10e7-4436-8fd8-728a8e8b8ddc'],
  ['1.5', 'Miejsce realizacji projektu', '3b7656d2-f2d7-44df-af43-4f4b58b4101f'],
  ['2.1', 'Cel projektu', 'c048ab30-3dda-4228-bf71-4ec6904cffda'],
  ['2.2', 'Opis rezultatu prac B+R', '80ebca16-a9dd-4798-a334-5ac007cecbf7'],
  ['2.3', 'Zapotrzebowanie rynkowe i potencjał', 'c5dbdc83-5baf-4866-b3d8-4da3ae553865'],
  ['2.4', 'Dodatkowe efekty zewnętrzne', '94fb1adb-38a5-4949-b4c1-b0a79472bfd3'],
  ['3.1', 'Sposób wdrożenia wyników projektu', '574f07ed-d631-4536-bfd0-e1f7e469415c'],
  ['3.2', 'Plan wdrożenia rezultatu', '06a70163-2dcc-47a0-b64b-201656946538'],
  ['3.3', 'Analiza opłacalności wdrożenia', 'bb231ac1-d863-41a8-89a7-88c1db3a1bd7'],
  ['3.4', 'Zasoby niezbędne do wdrożenia', '836f13ca-f474-4d5c-8388-6afd84eaf353'],
  ['3.5', 'Prawa własności intelektualnej', '41b2184d-76e9-4b79-8ece-b2e227dc471f'],
  ['4.1', 'Zespół projektowy', '5af236aa-03b2-4650-b5a2-95c299dfeeaf'],
  ['4.2', 'Zasoby techniczne oraz WNiP', '95a9b43d-b789-479a-a60d-159b975af74d'],
  ['4.3', 'Podwykonawcy', 'e8020b59-7947-4c3d-9851-0fc499f42427'],
  ['5.3', 'Premia za lokalizację', '72d09821-7019-4ac0-ab4f-09fdd4883fc2'],
  ['5.4', 'Premia za rozpowszechnianie', 'e635f786-a34c-4a29-b142-4f4081401a5c'],
  ['6.1', 'Plan prac B+R', '566c735c-8ad0-406f-a948-f3ea921c2cc7'],
  ['6.3', 'Wydatki rzeczywiste', 'fb417879-403e-4241-a202-ec23c6a6b866'],
  ['6.5', 'Koszty pośrednie', 'bdb2c7b3-92d9-4778-9ecc-b4c5bda7d32b'],
  ['7', 'Analiza ryzyka', '77be8643-1e31-4619-b266-d156a5388cf6'],
  ['8', 'Źródła finansowania wydatków', 'd31b6d68-33b7-45a0-a032-0f5f02b5aed8'],
  ['9.2', 'Wskaźniki rezultatu', 'e95d0c23-8a39-4d56-96fa-ace3e4f0d23a'],
  ['10.1', 'Zasady równości', 'e5bd23d7-9d4d-4f2e-948a-97c95041ef18'],
  ['10.2', 'Karta Praw Podstawowych', '51455d27-6e3d-4629-9cc6-2a124f5432c8'],
  ['10.3', 'Konwencja o Prawach Osób Niepełnosprawnych', '256ac98a-bb3c-4715-ad13-e8dbcd3f94f4'],
  ['10.4', 'Zasada zrównoważonego rozwoju', '4e260fae-c455-41ce-bba3-d0df2a8767fd'],
].map(([id, title, step]) => ({ id, title, url: `${projectUrl}/projekt_step/${step}` }));

function slug(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function stats(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return {
    chars: text.length,
    words: normalized ? normalized.split(/\s+/).length : 0,
    sha256: createHash('sha256').update(text).digest('hex'),
    preview: normalized.slice(0, 180),
  };
}

function joinFields(fields) {
  return fields
    .map((f) => {
      const label = f.label || f.name.split('.').slice(-1)[0] || 'pole';
      return `## ${label}\n\n${f.value.trim()}`;
    })
    .join('\n\n---\n\n')
    .trim();
}

async function waitForControls(page) {
  await page.waitForSelector('textarea, input, table, button', { timeout: 15_000 }).catch(() => {}); // allow-raw-playwright: wait for rendered LSI controls before read-only extraction
}

async function visibleFields(page) {
  return page.evaluate(() => {
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
    return Array.from(document.querySelectorAll('textarea, input[type="text"]')).map((el) => ({
      name: el.getAttribute('name') || '',
      label: labelFor(el).slice(0, 180),
      value: el.value || '',
      max: el.getAttribute('maxlength') || '',
    })).filter((f) => f.name && f.value.trim().length >= 80 && f.name !== 'table_search');
  }); // allow-raw-playwright: read-only extraction from visible text controls
}

async function rowCount(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('table tbody tr'))
    .filter((r) => r.querySelector('button[aria-label="overflow-options"]')).length); // allow-raw-playwright: read-only table row count
}

async function openRowForRead(page, index) {
  const rows = page.locator('table tbody tr').filter({ has: page.locator('button[aria-label="overflow-options"]') });
  const btn = rows.nth(index).locator('button[aria-label="overflow-options"]').first();
  const opened = await btn.count() > 0;
  if (opened) await humanClickLocator(page, btn);
  if (!opened) return false;
  await humanIdlePause('deliberate');
  const edit = page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first();
  if (await edit.count() === 0) {
    await page.keyboard.press('Escape'); // allow-raw-playwright: close row menu only
    return false;
  }
  await edit.dispatchEvent('click'); // allow-raw-playwright: open row form for read-only extraction
  await humanIdlePause('long');
  return true;
}

async function closeRow(page) {
  const buttons = page.getByRole('button', { name: 'Anuluj', exact: true }).filter({ visible: true });
  const count = await buttons.count();
  if (count) await humanClickLocator(page, buttons.nth(count - 1));
  await humanIdlePause('long');
}

async function extractSection(page, section) {
  console.error(`[ncbr-pangram] extracting ${section.id} ${section.title}`);
  await page.goto(section.url, { waitUntil: 'domcontentloaded', timeout: 30_000 }); // allow-raw-playwright: read-only LSI section navigation
  await waitForControls(page);
  await humanIdlePause('long');
  await page.evaluate(() => {
    const banner = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies'));
    if (banner) banner.style.pointerEvents = 'none';
  }); // allow-raw-playwright: neutralise cookie overlay only
  const fields = await visibleFields(page);
  const rowFields = [];
  if (includeRows) {
    const rows = await rowCount(page);
    console.error(`[ncbr-pangram] ${section.id}: visible=${fields.length} rows=${rows}`);
    for (let i = 0; i < rows; i += 1) {
      console.error(`[ncbr-pangram] ${section.id}: reading row ${i + 1}/${rows}`);
      await page.goto(section.url, { waitUntil: 'domcontentloaded', timeout: 30_000 }); // allow-raw-playwright: reset before next row read
      await waitForControls(page);
      await humanIdlePause('long');
      if (!await openRowForRead(page, i)) continue;
      const values = await visibleFields(page);
      for (const f of values) rowFields.push({ ...f, label: `Wiersz ${i + 1}: ${f.label || f.name}` });
      await closeRow(page);
    }
  }
  return { fields, rowFields, text: joinFields([...fields, ...rowFields]) };
}

function runPangram(item, textFile, reportDir) {
  const action = `pangram_${slug(item.section_id)}`;
  const env = {
    ...process.env,
    WELES_RUN_ID: runId,
    ACTION: action,
    PANGRAM_TEXT_FILE: textFile,
    PANGRAM_REQUIRE_ACCOUNT: '1',
    WELES_CAPTURE_RESPONSE_BODIES: '1',
  };
  const resultPath = join(process.cwd(), 'recordings', runId, action, 'pangram_result.json');
  const banPath = join(process.cwd(), 'recordings', runId, action, 'ban_signal.json');
  for (const path of [resultPath, banPath]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
  const res = spawnSync(process.execPath, ['src/trajectories/pangram/analyze_text.mjs'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    timeout: Number(process.env.PANGRAM_SECTION_TIMEOUT_MS || 180_000),
  });
  const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null;
  const banSignal = existsSync(banPath) ? JSON.parse(readFileSync(banPath, 'utf8')) : null;
  const logPath = join(reportDir, `${slug(item.section_id)}.pangram.log`);
  writeFileSync(logPath, `${res.stdout || ''}\n${res.stderr || ''}`.trim());
  return {
    section_id: item.section_id,
    title: item.title,
    exitCode: res.status,
    signal: res.signal,
    timedOut: Boolean(res.error && /timed out/i.test(String(res.error.message || res.error))),
    logPath,
    result,
    banSignal,
  };
}

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2));
  process.exit(1);
}
page.setDefaultTimeout(30_000);

const reportDir = runRecordingsDir('ncbr_pangram_audit');
const textDir = join(reportDir, 'sections');
mkdirSync(textDir, { recursive: true });

const extracted = [];
for (const section of sections) {
  if (sectionPattern && !sectionPattern.test(`${section.id} ${section.title}`)) continue;
  const data = await extractSection(page, section);
  if (data.text.length < minChars) continue;
  const file = join(textDir, `${slug(section.id)}.txt`);
  writeFileSync(file, data.text);
  extracted.push({
    section_id: section.id,
    title: section.title,
    url: section.url,
    textFile: file,
    visibleFieldCount: data.fields.length,
    rowFieldCount: data.rowFields.length,
    ...stats(data.text),
  });
  if (extracted.length >= maxSections) break;
}

const manifestPath = join(reportDir, 'manifest.json');
writeFileSync(manifestPath, JSON.stringify({
  projectId,
  runId,
  collectOnly,
  includeRows,
  minChars,
  maxSections,
  sectionPattern: process.env.SECTION_PATTERN || null,
  extracted,
}, null, 2));

const pangram = [];
if (!collectOnly) {
  for (const item of extracted) {
    console.error(`[ncbr-pangram] Pangram ${item.section_id} (${item.chars} chars)`);
    pangram.push(runPangram(item, item.textFile, reportDir));
  }
}

const summary = pangram.map((p) => {
  const trusted = p.exitCode === 0 && p.banSignal?.healthy === true && p.result?.source && p.result.source !== 'none';
  return {
    section_id: p.section_id,
    title: p.title,
    exitCode: p.exitCode,
    banSignal: p.banSignal?.signal || null,
    trusted,
    verdict: trusted ? p.result?.verdict || null : null,
    ai_percent: trusted ? p.result?.ai_percent ?? null : null,
    human_percent: trusted ? p.result?.human_percent ?? null : null,
    confidence_percent: trusted ? p.result?.confidence_percent ?? null : null,
    source: trusted ? p.result?.source || null : null,
  };
});

const reportPath = join(reportDir, 'report.json');
writeFileSync(reportPath, JSON.stringify({
  projectId,
  runId,
  manifestPath,
  collectOnly,
  extractedCount: extracted.length,
  pangram,
  summary,
}, null, 2));

console.log(JSON.stringify({
  projectId,
  runId,
  reportDir,
  manifestPath,
  reportPath,
  collectOnly,
  extractedCount: extracted.length,
  summary,
}, null, 2));
process.exit(pangram.some((p) => p.exitCode !== 0) ? 2 : 0);
