// Read-only Pangram audit for long text answers in the replacement NCBR draft.
// Extracts LSI section text to local files, then optionally runs Pangram.
// Never writes to LSI and never submits the application.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  humanClickLocator,
  humanIdlePause,
} from '../../../dist/human/mouse.js';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';

const endpoint = (await import('#ncbr-settings')).cdpEndpoint();
const projectId = (await import('#ncbr-settings')).projectId();
const projectUrl = ['https://', `lsi2.ncbr.gov.pl/projekt/${projectId}`].join(
  '',
);
const sectionPattern = process.env.SECTION_PATTERN
  ? new RegExp(process.env.SECTION_PATTERN)
  : null;
const collectOnly = process.env.COLLECT_ONLY === '1';
const includeRows = process.env.INCLUDE_ROWS === '1';
const runId =
  process.env.WELES_RUN_ID ||
  `ncbr-pangram-${new Date().toISOString().replace(/[:.]/g, '-')}`;
process.env.WELES_RUN_ID = runId;

const sections = [
  [
    '1.1',
    'Informacje ogólne o projekcie',
    (await import('#ncbr-settings')).sectionId('1_1'),
  ],
  [
    '1.2',
    'Klasyfikacja projektu',
    (await import('#ncbr-settings')).sectionId('1_2'),
  ],
  [
    '1.3',
    'Podmioty realizujące projekt',
    (await import('#ncbr-settings')).sectionId('1_3'),
  ],
  ['1.4', 'Konkurencja', (await import('#ncbr-settings')).sectionId('1_4')],
  [
    '1.5',
    'Miejsce realizacji projektu',
    (await import('#ncbr-settings')).sectionId('1_5'),
  ],
  ['2.1', 'Cel projektu', (await import('#ncbr-settings')).sectionId('2_1')],
  [
    '2.2',
    'Opis rezultatu prac B+R',
    (await import('#ncbr-settings')).sectionId('2_2'),
  ],
  [
    '2.3',
    'Zapotrzebowanie rynkowe i potencjał',
    (await import('#ncbr-settings')).sectionId('2_3'),
  ],
  [
    '2.4',
    'Dodatkowe efekty zewnętrzne',
    (await import('#ncbr-settings')).sectionId('2_4'),
  ],
  [
    '3.1',
    'Sposób wdrożenia wyników projektu',
    (await import('#ncbr-settings')).sectionId('3_1'),
  ],
  [
    '3.2',
    'Plan wdrożenia rezultatu',
    (await import('#ncbr-settings')).sectionId('3_2'),
  ],
  [
    '3.3',
    'Analiza opłacalności wdrożenia',
    (await import('#ncbr-settings')).sectionId('3_3'),
  ],
  [
    '3.4',
    'Zasoby niezbędne do wdrożenia',
    (await import('#ncbr-settings')).sectionId('3_4'),
  ],
  [
    '3.5',
    'Prawa własności intelektualnej',
    (await import('#ncbr-settings')).sectionId('3_5'),
  ],
  [
    '4.1',
    'Zespół projektowy',
    (await import('#ncbr-settings')).sectionId('4_1'),
  ],
  [
    '4.2',
    'Zasoby techniczne oraz WNiP',
    (await import('#ncbr-settings')).sectionId('4_2'),
  ],
  ['4.3', 'Podwykonawcy', (await import('#ncbr-settings')).sectionId('4_3')],
  [
    '5.3',
    'Premia za lokalizację',
    (await import('#ncbr-settings')).sectionId('5_3'),
  ],
  [
    '5.4',
    'Premia za rozpowszechnianie',
    (await import('#ncbr-settings')).sectionId('5_4'),
  ],
  ['6.1', 'Plan prac B+R', (await import('#ncbr-settings')).sectionId('6_1')],
  [
    '6.3',
    'Wydatki rzeczywiste',
    (await import('#ncbr-settings')).sectionId('6_3'),
  ],
  [
    '6.5',
    'Koszty pośrednie',
    (await import('#ncbr-settings')).sectionId('6_5'),
  ],
  ['7', 'Analiza ryzyka', (await import('#ncbr-settings')).sectionId('7')],
  [
    '8',
    'Źródła finansowania wydatków',
    (await import('#ncbr-settings')).sectionId('8'),
  ],
  [
    '9.2',
    'Wskaźniki rezultatu',
    (await import('#ncbr-settings')).sectionId('9_2'),
  ],
  [
    '10.1',
    'Zasady równości',
    (await import('#ncbr-settings')).sectionId('10_1'),
  ],
  [
    '10.2',
    'Karta Praw Podstawowych',
    (await import('#ncbr-settings')).sectionId('10_2'),
  ],
  [
    '10.3',
    'Konwencja o Prawach Osób Niepełnosprawnych',
    (await import('#ncbr-settings')).sectionId('10_3'),
  ],
  [
    '10.4',
    'Zasada zrównoważonego rozwoju',
    (await import('#ncbr-settings')).sectionId('10_4'),
  ],
].map(([id, title, step]) => ({
  id,
  title,
  url: `${projectUrl}/projekt_step/${step}`,
}));

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
    preview: normalized,
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
  await page.waitForSelector('textarea, input, table, button'); // allow-raw-playwright: wait for rendered LSI controls before read-only extraction
}

async function visibleFields(page) {
  return page.evaluate(() => {
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
    return Array.from(document.querySelectorAll('textarea, input[type="text"]'))
      .map((el) => ({
        name: el.getAttribute('name') || '',
        label: labelFor(el),
        value: el.value || '',
        max: el.getAttribute('maxlength') || '',
      }))
      .filter(
        (f) =>
          f.name && f.value.trim().length >= 80 && f.name !== 'table_search',
      );
  }); // allow-raw-playwright: read-only extraction from visible text controls
}

async function rowCount(page) {
  return page.evaluate(
    () =>
      Array.from(document.querySelectorAll('table tbody tr')).filter((r) =>
        r.querySelector('button[aria-label="overflow-options"]'),
      ).length,
  ); // allow-raw-playwright: read-only table row count
}

async function openRowForRead(page, index) {
  const rows = page
    .locator('table tbody tr')
    .filter({ has: page.locator('button[aria-label="overflow-options"]') });
  const btn = rows
    .nth(index)
    .locator('button[aria-label="overflow-options"]')
    .first();
  const opened = (await btn.count()) > 0;
  if (opened) await humanClickLocator(page, btn);
  if (!opened) return false;
  await humanIdlePause('deliberate');
  const edit = page
    .getByRole('menuitem', { name: 'Edytuj', exact: true })
    .first();
  if ((await edit.count()) === 0) {
    await page.keyboard.press('Escape'); // allow-raw-playwright: close row menu only
    return false;
  }
  await edit.dispatchEvent('click'); // allow-raw-playwright: open row form for read-only extraction
  await humanIdlePause('long');
  return true;
}

async function closeRow(page) {
  const buttons = page
    .getByRole('button', { name: 'Anuluj', exact: true })
    .filter({ visible: true });
  const count = await buttons.count();
  if (count) await humanClickLocator(page, buttons.nth(count - 1));
  await humanIdlePause('long');
}

async function extractSection(page, section) {
  console.error(`[ncbr-pangram] extracting ${section.id} ${section.title}`);
  await page.goto(section.url, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: read-only LSI section navigation
  await waitForControls(page);
  await humanIdlePause('long');
  await page.evaluate(() => {
    const banner = Array.from(document.querySelectorAll('div')).find((d) =>
      (d.innerText || '').includes('pliki cookies'),
    );
    if (banner) banner.style.pointerEvents = 'none';
  }); // allow-raw-playwright: neutralise cookie overlay only
  const fields = await visibleFields(page);
  const rowFields = [];
  if (includeRows) {
    const rows = await rowCount(page);
    console.error(
      `[ncbr-pangram] ${section.id}: visible=${fields.length} rows=${rows}`,
    );
    for (let i = 0; i < rows; i += 1) {
      console.error(
        `[ncbr-pangram] ${section.id}: reading row ${i + 1}/${rows}`,
      );
      await page.goto(section.url, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: reset before next row read
      await waitForControls(page);
      await humanIdlePause('long');
      if (!(await openRowForRead(page, i))) continue;
      const values = await visibleFields(page);
      for (const f of values)
        rowFields.push({
          ...f,
          label: `Wiersz ${i + 1}: ${f.label || f.name}`,
        });
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
  const resultPath = join(
    process.cwd(),
    'recordings',
    runId,
    action,
    'pangram_result.json',
  );
  const banPath = join(
    process.cwd(),
    'recordings',
    runId,
    action,
    'ban_signal.json',
  );
  for (const path of [resultPath, banPath]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
  const res = spawnSync(
    process.execPath,
    ['src/trajectories/pangram/analyze_text.mjs'],
    { cwd: process.cwd(), env, encoding: 'utf8' },
  );
  const result = existsSync(resultPath)
    ? JSON.parse(readFileSync(resultPath, 'utf8'))
    : null;
  const banSignal = existsSync(banPath)
    ? JSON.parse(readFileSync(banPath, 'utf8'))
    : null;
  const logPath = join(reportDir, `${slug(item.section_id)}.pangram.log`);
  writeFileSync(logPath, `${res.stdout || ''}\n${res.stderr || ''}`.trim());
  return {
    section_id: item.section_id,
    title: item.title,
    exitCode: res.status,
    signal: res.signal,
    spawnError: res.error ? String(res.error.message || res.error) : null,
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

const reportDir = runRecordingsDir('ncbr_pangram_audit');
const textDir = join(reportDir, 'sections');
mkdirSync(textDir, { recursive: true });

const extracted = [];
for (const section of sections) {
  if (sectionPattern && !sectionPattern.test(`${section.id} ${section.title}`))
    continue;
  const data = await extractSection(page, section);
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
}

const manifestPath = join(reportDir, 'manifest.json');
writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      projectId,
      runId,
      collectOnly,
      includeRows,
      sectionPattern: process.env.SECTION_PATTERN || null,
      extracted,
    },
    null,
    2,
  ),
);

const pangram = [];
if (!collectOnly) {
  for (const item of extracted) {
    console.error(
      `[ncbr-pangram] Pangram ${item.section_id} (${item.chars} chars)`,
    );
    pangram.push(runPangram(item, item.textFile, reportDir));
  }
}

const summary = pangram.map((p) => {
  const trusted =
    p.exitCode === 0 &&
    p.banSignal?.healthy === true &&
    p.result?.source &&
    p.result.source !== 'none';
  return {
    section_id: p.section_id,
    title: p.title,
    exitCode: p.exitCode,
    banSignal: p.banSignal?.signal || null,
    trusted,
    verdict: trusted ? p.result?.verdict || null : null,
    ai_percent: trusted ? (p.result?.ai_percent ?? null) : null,
    human_percent: trusted ? (p.result?.human_percent ?? null) : null,
    confidence_percent: trusted ? (p.result?.confidence_percent ?? null) : null,
    source: trusted ? p.result?.source || null : null,
  };
});

const reportPath = join(reportDir, 'report.json');
writeFileSync(
  reportPath,
  JSON.stringify(
    {
      projectId,
      runId,
      manifestPath,
      collectOnly,
      extractedCount: extracted.length,
      pangram,
      summary,
    },
    null,
    2,
  ),
);

console.log(
  JSON.stringify(
    {
      projectId,
      runId,
      reportDir,
      manifestPath,
      reportPath,
      collectOnly,
      extractedCount: extracted.length,
      summary,
    },
    null,
    2,
  ),
);
process.exit(pangram.some((p) => p.exitCode !== 0) ? 2 : 0);
