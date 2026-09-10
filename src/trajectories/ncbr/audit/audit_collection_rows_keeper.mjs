// Read-only deep audit of collection row subforms in the NCBR STEP B draft.
// Opens existing rows via visible UI, reads fields/limits, closes with Anuluj.
// Never saves, deletes, uploads, submits, withdraws, or calls LSI APIs.

import net from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSION = process.env.SESSION || 'ncbr-step-b';
const PROJECT_ID = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const PROJECT_URL = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}`;
const BASE = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}/projekt_step/`;
const OUT_DIR = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/audit_collection_rows_20260625';
const EMAIL = process.env.NCBR_EMAIL || '';
const PASSWORD = process.env.NCBR_PASSWORD || '';
delete process.env.NCBR_PASSWORD;

const SECTIONS = [
  ['1.3', '317a21dd-e798-4115-ab53-6ab5a2912fb0'],
  ['1.4', '4a6e9d5d-10e7-4436-8fd8-728a8e8b8ddc'],
  ['1.5', '3b7656d2-f2d7-44df-af43-4f4b58b4101f'],
  ['2.2', '80ebca16-a9dd-4798-a334-5ac007cecbf7'],
  ['2.3', 'c5dbdc83-5baf-4866-b3d8-4da3ae553865'],
  ['2.4', '94fb1adb-38a5-4949-b4c1-b0a79472bfd3'],
  ['3.1', '574f07ed-d631-4536-bfd0-e1f7e469415c'],
  ['4.1', '5af236aa-03b2-4650-b5a2-95c299dfeeaf'],
  ['4.2', '95a9b43d-b789-479a-a60d-159b975af74d'],
  ['4.3', 'e8020b59-7947-4c3d-9851-0fc499f42427'],
  ['5.3', '72d09821-7019-4ac0-ab4f-09fdd4883fc2'],
  ['5.4', 'e635f786-a34c-4a29-b142-4f4081401a5c'],
  ['6.1', '566c735c-8ad0-406f-a948-f3ea921c2cc7'],
  ['6.3', 'fb417879-403e-4241-a202-ec23c6a6b866'],
  ['6.5', 'bdb2c7b3-92d9-4778-9ecc-b4c5bda7d32b'],
  ['8', 'd31b6d68-33b7-45a0-a032-0f5f02b5aed8'],
  ['9.1', '8ff0ee28-01e7-4a83-96c0-e11049be2c70'],
  ['9.2', 'e95d0c23-8a39-4d56-96fa-ace3e4f0d23a'],
  ['10.1', 'e5bd23d7-9d4d-4f2e-948a-97c95041ef18'],
  ['10.4', '4e260fae-c455-41ce-bba3-d0df2a8767fd'],
];

mkdirSync(OUT_DIR, { recursive: true });

function send(cmd, timeoutMs = 120000, optional = false) {
  const sock = join(homedir(), '.weles', 'keeper', SESSION, 'socket');
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sock);
    let buf = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      conn.destroy();
      const err = new Error(`keeper timeout for ${cmd.action}`);
      if (optional) resolve({ ok: false, error: err.message });
      else reject(err);
    }, timeoutMs);
    conn.on('connect', () => conn.write(`${JSON.stringify(cmd)}\n`));
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0 || done) return;
      done = true;
      clearTimeout(timer);
      conn.end();
      const res = JSON.parse(buf.slice(0, nl));
      if (!res.ok && !optional) reject(new Error(`${cmd.action} failed: ${res.error}`));
      else resolve(res);
    });
    conn.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (optional) resolve({ ok: false, error: err.message });
      else reject(err);
    });
  });
}

const action = (cmd, timeoutMs = 120000, optional = false) => send(cmd, timeoutMs, optional);
const read = async (js) => (await action({ action: 'eval', js }, 120000)).result;

async function click(selector, timeoutMs = 90000, optional = false) {
  const fast = await action({ action: 'click_fast', selector }, Math.min(timeoutMs, 25000), true);
  if (fast.ok) return fast;
  if (optional) return fast;
  throw new Error(`click failed: ${selector}: ${fast.error || 'unknown'}`);
}

async function dispatchClick(selector, timeoutMs = 90000, optional = false) {
  const res = await action({ action: 'dispatch_click', selector }, Math.min(timeoutMs, 25000), true);
  if (res.ok) return res;
  if (optional) return res;
  throw new Error(`dispatch click failed: ${selector}: ${res.error || 'unknown'}`);
}

async function idle(kind = 'short') {
  await action({ action: 'humanidle', kind }, 60000, true);
}

async function nav(label, id) {
  await action({ action: 'nav', url: `${BASE}${id}` }, 180000);
  await idle('long');
  const url = await action({ action: 'url' }, 30000);
  return { label, url: url.url };
}

async function loginIfNeeded() {
  await action({ action: 'nav', url: PROJECT_URL }, 180000);
  await idle('long');
  const state = await read(`(() => ({
    url: location.href,
    hasMail: Boolean(document.querySelector('#mail, input[name="mail"]')),
    hasPassword: Boolean(document.querySelector('#password, input[name="password"]')),
  }))()`);
  if (!state.hasMail || !state.hasPassword) return { status: 'already_authenticated_or_project_page', state };
  if (!EMAIL || !PASSWORD) throw new Error('login page reached but NCBR_EMAIL/NCBR_PASSWORD are not set');
  await action({ action: 'fill', selector: '#mail, input[name="mail"]', text: EMAIL }, 120000);
  await idle('short');
  await action({ action: 'fill', selector: '#password, input[name="password"]', text: PASSWORD }, 120000);
  await idle('short');
  const check = await read(`(() => {
    const el = document.querySelector('#isStatuteAccepted, input[name="isStatuteAccepted"]');
    return el ? { present: true, checked: el.checked } : { present: false };
  })()`);
  if (check.present && !check.checked) await action({ action: 'click', selector: '#isStatuteAccepted, input[name="isStatuteAccepted"]' }, 120000);
  await action({ action: 'click', selector: '#login-btn, button:has-text("Zaloguj")' }, 120000);
  await idle('long');
  await idle('long');
  return read(`(() => ({ status: location.href.includes('/logowanie') ? 'still_login_page' : 'logged_in', url: location.href }))()`);
}

async function rowButtons() {
  return read(`(() => {
    const allRows = Array.from(document.querySelectorAll('table tbody tr'));
    return Array.from(document.querySelectorAll('table')).flatMap((table, tableIndex) =>
      Array.from(table.querySelectorAll('tbody tr')).map((row, rowIndex) => {
        const btn = row.querySelector('button[aria-label="overflow-options"]');
        if (!btn) return null;
        return {
          tableIndex,
          rowIndex,
          globalRowIndex: allRows.indexOf(row) + 1,
          text: row.innerText.trim().replace(/\\s+/g, ' ').slice(0, 700),
        };
      }).filter(Boolean)
    );
  })()`);
}

async function readOpenFields() {
  return read(`(() => {
    const drawer = Array.from(document.querySelectorAll('.MuiDrawer-root'))
      .find((el) => !String(el.className || '').includes('MuiModal-hidden') && (el.innerText || '').includes('Anuluj'));
    const dialog = Array.from(document.querySelectorAll('[role="dialog"], .MuiDialog-root'))
      .find((el) => (el.innerText || '').includes('Anuluj'));
    const scope = drawer || dialog || document;
    const visible = (el) => Boolean(el.offsetParent);
    const fields = Array.from(scope.querySelectorAll('input, textarea, select'))
      .filter((el) => visible(el) && el.name && el.name !== 'table_search')
      .map((el) => {
        const id = el.id || '';
        const lab = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]')?.textContent?.trim() : '';
        const value = String(el.value || '');
        const max = el.getAttribute('maxlength') || '';
        return {
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || '',
          name: el.name,
          label: lab || '',
          len: value.length,
          max,
          diff: max ? Number(max) - value.length : null,
          invalid: el.getAttribute('aria-invalid') || '',
          valueHead: value.slice(0, 220),
          valueTail: value.slice(-220),
        };
      });
    return {
      title: (scope.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 500),
      fields,
      overLimit: fields.filter((f) => f.max && f.len > Number(f.max)),
      markdownHits: fields.filter((f) => /(\\*\\*|#{1,6}\\s|<!--|\\|---|\\(limit\\s*\\d)/i.test(f.valueHead) || /(\\*\\*|#{1,6}\\s|<!--|\\|---|\\(limit\\s*\\d)/i.test(f.valueTail)),
      shortNearLimit: fields.filter((f) => f.max && f.len > 100 && Number(f.max) - f.len > 10),
    };
  })()`);
}

async function closeEditor() {
  await click('#collection-obj-form-cancel-btn, button:has-text("Anuluj")', 90000, true);
  await idle('short');
  const confirm = await read(`(() => Array.from(document.querySelectorAll('[role="dialog"] button')).map((b) => b.innerText.trim()).filter(Boolean))()`);
  if (confirm.includes('Wyjdź')) {
    await click('button:has-text("Wyjdź")', 90000, true);
    await idle('short');
  }
}

async function inspectRow(row) {
  const needle = String(row.text || '').slice(0, 90);
  const byText = needle ? `tr:has-text(${JSON.stringify(needle)}) button[aria-label="overflow-options"]` : '';
  const exactSelector = `:nth-match(table tbody tr, ${row.globalRowIndex}) button[aria-label="overflow-options"]`;
  const selectors = [byText, exactSelector].filter(Boolean);
  let openMenu = { ok: false, error: 'menu not attempted' };
  let menuVisible = false;
  for (const selector of selectors) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      openMenu = attempt === 0
        ? await click(selector, 12000, true)
        : await dispatchClick(selector, 12000, true);
      await idle('short');
      menuVisible = await read(`(() => Array.from(document.querySelectorAll('[role="menuitem"], li, button'))
        .some((el) => Boolean(el.offsetParent) && el.innerText.trim() === 'Edytuj'))()`);
      if (openMenu.ok && menuVisible) break;
    }
    if (openMenu.ok && menuVisible) break;
  }
  if (!openMenu.ok || !menuVisible) return { row, editable: false, error: `menu open failed: ${openMenu.error || 'unknown'}` };
  await idle('short');
  const menu = await read(`(() => Array.from(document.querySelectorAll('[role="menu"], .MuiMenu-paper')).map((e) => e.innerText.trim()).filter(Boolean))()`);
  let edit = await dispatchClick('[role="menuitem"]:has-text("Edytuj")', 25000, true);
  if (!edit.ok) edit = await click('[role="menuitem"]:has-text("Edytuj")', 25000, true);
  await idle('long');
  if (!edit.ok) return { row, editable: false, menu, error: edit.error || null };
  const opened = await read(`(() => Boolean(document.querySelector('#collection-obj-form-cancel-btn')))()`);
  if (!opened) return { row, editable: false, menu, error: 'edit click did not open collection form' };
  const open = await readOpenFields();
  await closeEditor();
  if (!open.fields.length) return { row, editable: false, menu, error: 'collection form opened but no visible named fields', ...open };
  return { row, editable: true, menu, ...open };
}

const wanted = process.env.SECTION_FILTER
  ? new Set(process.env.SECTION_FILTER.split(',').map((s) => s.trim()).filter(Boolean))
  : null;
const sections = wanted ? SECTIONS.filter(([label]) => wanted.has(label)) : SECTIONS;

const out = {
  projectId: PROJECT_ID,
  session: SESSION,
  startedAt: new Date().toISOString(),
  sections: [],
};

try {
  out.login = await loginIfNeeded();
  for (const [label, id] of sections) {
    const navState = await nav(label, id);
    const rows = await rowButtons();
    const section = { label, id, nav: navState, rowCount: rows.length, rows: [] };
    out.sections.push(section);
    console.log(JSON.stringify({ progress: label, rows: rows.length }));
    for (let rowOrdinal = 0; rowOrdinal < rows.length; rowOrdinal += 1) {
      await nav(label, id);
      const currentRows = await rowButtons();
      const row = currentRows[rowOrdinal];
      if (!row) {
        section.rows.push({ rowOrdinal, editable: false, error: 'row disappeared before inspection' });
        continue;
      }
      const inspected = await inspectRow(row);
      section.rows.push(inspected);
      writeFileSync(join(OUT_DIR, 'partial.json'), JSON.stringify(out, null, 2));
      console.log(JSON.stringify({
        progress: label,
        table: row.tableIndex,
        row: row.rowIndex,
        editable: inspected.editable,
        fields: inspected.fields?.length || 0,
        over: inspected.overLimit?.length || 0,
        short: inspected.shortNearLimit?.length || 0,
        markdown: inspected.markdownHits?.length || 0,
        error: inspected.error || null,
      }));
    }
    writeFileSync(join(OUT_DIR, 'partial.json'), JSON.stringify(out, null, 2));
  }
  out.finishedAt = new Date().toISOString();
  out.summary = {
    sections: out.sections.length,
    rows: out.sections.reduce((sum, s) => sum + s.rows.length, 0),
    overLimit: out.sections.flatMap((s) => s.rows.flatMap((r) => r.overLimit || [])).length,
    shortNearLimit: out.sections.flatMap((s) => s.rows.flatMap((r) => r.shortNearLimit || [])).length,
    markdownHits: out.sections.flatMap((s) => s.rows.flatMap((r) => r.markdownHits || [])).length,
  };
  const fp = join(OUT_DIR, `audit_${sections.map(([l]) => l).join('_').replace(/[^0-9A-Za-z_.-]+/g, '_') || 'all'}.json`);
  writeFileSync(fp, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ok: true, out: fp, summary: out.summary }, null, 2));
} catch (e) {
  out.error = String(e?.stack || e);
  writeFileSync(join(OUT_DIR, 'error.json'), JSON.stringify(out, null, 2));
  console.error(out.error);
  process.exit(1);
}
