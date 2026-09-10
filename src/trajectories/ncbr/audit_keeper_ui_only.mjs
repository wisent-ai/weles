// UI-only readback audit for the NCBR STEP B draft.
// Uses an existing keeper session. Never saves, uploads, deletes, withdraws, or submits.

import net from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSION = process.env.SESSION || 'ncbr-step-b';
const PROJECT_ID = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const PROJECT_URL = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}`;
const BASE = `${PROJECT_URL}/projekt_step/`;
const OUT_DIR = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/audit_keeper_ui_only_20260625';
const EMAIL = process.env.NCBR_EMAIL || '';
const PASSWORD = process.env.NCBR_PASSWORD || '';
delete process.env.NCBR_PASSWORD;

const FALLBACK_SECTIONS = [
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
  ['6.4', '7f63b840-57b3-4e73-9fb0-91c6f24cad44'],
  ['6.5', 'bdb2c7b3-92d9-4778-9ecc-b4c5bda7d32b'],
  ['8', 'd31b6d68-33b7-45a0-a032-0f5f02b5aed8'],
  ['9.1', '8ff0ee28-01e7-4a83-96c0-e11049be2c70'],
  ['9.2', 'e95d0c23-8a39-4d56-96fa-ace3e4f0d23a'],
  ['10.1', 'e5bd23d7-9d4d-4f2e-948a-97c95041ef18'],
  ['10.2', '51455d27-6e3d-4629-9cc6-2a124f5432c8'],
  ['10.3', '256ac98a-bb3c-4715-ad13-e8dbcd3f94f4'],
  ['10.4', '4e260fae-c455-41ce-bba3-d0df2a8767fd'],
];

mkdirSync(OUT_DIR, { recursive: true });

function send(cmd, timeoutMs = 120000) {
  const sock = join(homedir(), '.weles', 'keeper', SESSION, 'socket');
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sock);
    let buf = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      conn.destroy();
      reject(new Error(`keeper timeout for ${cmd.action}`));
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
      if (!res.ok) reject(new Error(`${cmd.action} failed: ${res.error}`));
      else resolve(res);
    });
    conn.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function nav(url) {
  const out = await send({ action: 'nav', url }, 180000);
  await send({ action: 'humanidle', kind: 'long' }, 60000).catch(() => null);
  return out;
}

async function read(js) {
  return (await send({ action: 'eval', js }, 120000)).result;
}

async function screenshot(label) {
  if (process.env.SKIP_SCREENSHOTS === '1') return { label, path: null };
  const out = await send({ action: 'screenshot' }, 120000);
  return { label, path: out.path };
}

async function loginIfNeeded() {
  await nav(PROJECT_URL);
  const state = await read(`(() => ({
    url: location.href,
    hasMail: Boolean(document.querySelector('#mail, input[name="mail"]')),
    hasPassword: Boolean(document.querySelector('#password, input[name="password"]')),
    body: (document.body.innerText || '').slice(0, 1200),
  }))()`);
  if (!state.hasMail || !state.hasPassword) return { status: 'already_authenticated_or_project_page', state };
  if (!EMAIL || !PASSWORD) return { status: 'needs_credentials', state };
  await send({ action: 'fill', selector: '#mail, input[name="mail"]', text: EMAIL }, 120000);
  await send({ action: 'fill', selector: '#password, input[name="password"]', text: PASSWORD }, 120000);
  const check = await read(`(() => {
    const el = document.querySelector('#isStatuteAccepted, input[name="isStatuteAccepted"]');
    return el ? { present: true, checked: el.checked } : { present: false };
  })()`);
  if (check.present && !check.checked) {
    await send({ action: 'click', selector: '#isStatuteAccepted, input[name="isStatuteAccepted"]' }, 120000);
  }
  await send({ action: 'click', selector: '#login-btn, button:has-text("Zaloguj")' }, 120000);
  await send({ action: 'humanidle', kind: 'long' }, 60000).catch(() => null);
  await send({ action: 'humanidle', kind: 'long' }, 60000).catch(() => null);
  const after = await read(`(() => ({ url: location.href, body: (document.body.innerText || '').slice(0, 1200) }))()`);
  return { status: after.url.includes('/logowanie') ? 'still_login_page' : 'logged_in', after };
}

async function discoverSections() {
  await nav(PROJECT_URL);
  const links = await read(`(() => {
    const out = [];
    for (const a of Array.from(document.querySelectorAll('a[href]'))) {
      if (!a.href.includes('/projekt_step/')) continue;
      const id = a.href.split('/projekt_step/')[1]?.split(/[?#/]/)[0];
      const label = (a.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
      if (id) out.push([label || id, id]);
    }
    return out;
  })()`);
  const seen = new Set();
  const merged = [...links, ...FALLBACK_SECTIONS].filter(([label, id]) => {
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return merged;
}

async function dumpSection(label, id) {
  await nav(`${BASE}${id}`);
  const state = await read(`(() => {
    const body = document.body.innerText || '';
    const fields = Array.from(document.querySelectorAll('input, textarea, select')).map((el) => {
      const raw = 'value' in el ? String(el.value || '') : '';
      const max = el.getAttribute('maxlength') || '';
      const id = el.id || '';
      const lab = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]')?.textContent?.trim() : '';
      return {
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        name: el.getAttribute('name') || '',
        label: lab || '',
        len: raw.length,
        max,
        diff: max ? Number(max) - raw.length : null,
        value: raw.slice(0, 260),
        suffix: raw.slice(-260),
        invalid: el.getAttribute('aria-invalid') || '',
      };
    }).filter((f) => f.name && f.name !== 'table_search');
    const tables = Array.from(document.querySelectorAll('table')).map((table, i) => ({
      i,
      rows: table.querySelectorAll('tbody tr').length,
      text: Array.from(table.querySelectorAll('tbody tr')).map((r) => r.innerText.trim().replace(/\\s+/g, ' ').slice(0, 600)).slice(0, 40),
    }));
    return {
      url: location.href,
      title: document.title,
      heading: (document.querySelector('h1,h2,h3')?.textContent || '').trim(),
      bodyHead: body.slice(0, 2400),
      bodyTail: body.slice(-2400),
      fields,
      tables,
      fileInputs: Array.from(document.querySelectorAll('input[type="file"]')).map((e) => ({ name: e.name, accept: e.accept, multiple: e.multiple })),
      markdownLikeFields: fields.filter((f) => /(\\*\\*|#{1,6}\\s|<!--|\\|---|\\(limit\\s*\\d)/i.test(f.value) || /(\\*\\*|#{1,6}\\s|<!--|\\|---|\\(limit\\s*\\d)/i.test(f.suffix)),
      overLimitFields: fields.filter((f) => f.max && f.len > Number(f.max)).map((f) => ({ name: f.name, len: f.len, max: f.max, label: f.label })),
      shortNearLimitFields: fields.filter((f) => f.max && f.len > 100 && Number(f.max) - f.len > 10).map((f) => ({ name: f.name, len: f.len, max: f.max, diff: Number(f.max) - f.len, label: f.label })),
      suspiciousEndings: fields.filter((f) => f.len > 100 && !/[.!?…:;)"”\\]]$/.test(String(f.suffix).trim())).map((f) => ({ name: f.name, len: f.len, suffix: f.suffix.slice(-180), label: f.label })),
    };
  })()`);
  return { label, id, ...state, screenshot: await screenshot(label) };
}

async function validateOnly() {
  await nav(PROJECT_URL);
  let clicked = false;
  try {
    await send({ action: 'click', selector: 'button:has-text("Sprawdź wniosek")' }, 120000);
    clicked = true;
    await send({ action: 'humanidle', kind: 'long' }, 60000).catch(() => null);
    await send({ action: 'humanidle', kind: 'long' }, 60000).catch(() => null);
  } catch (e) {
    return { clicked, error: String(e?.message || e), screenshot: await screenshot('validation_failed') };
  }
  const state = await read(`(() => {
    const body = document.body.innerText || '';
    return {
      url: location.href,
      dialogs: Array.from(document.querySelectorAll('[role="dialog"], .MuiDialog-root, .MuiAlert-root, .MuiSnackbar-root')).map((e) => e.textContent.trim().replace(/\\s+/g, ' ')).filter(Boolean).slice(0, 40),
      errorLikeLines: body.split('\\n').map((l) => l.trim()).filter((l) => /błąd|blad|wymagan|uzupeł|niepopraw|nie może|walid|popraw/i.test(l)).slice(0, 140),
      submitButtons: Array.from(document.querySelectorAll('button')).map((b) => ({ text: b.innerText.trim(), disabled: b.disabled })).filter((b) => /Złóż|Sprawdź|Potwierdzam/i.test(b.text)),
      bodyTail: body.slice(-5000),
    };
  })()`);
  return { clicked, ...state, screenshot: await screenshot('validation') };
}

const out = {
  projectId: PROJECT_ID,
  session: SESSION,
  startedAt: new Date().toISOString(),
  sections: [],
};

try {
  out.login = await loginIfNeeded();
  if (out.login.status === 'needs_credentials' || out.login.status === 'still_login_page') {
    throw new Error(`login not ready: ${out.login.status}`);
  }
  let sections = await discoverSections();
  if (process.env.SECTION_FILTER) {
    const wanted = new Set(process.env.SECTION_FILTER.split(',').map((s) => s.trim()).filter(Boolean));
    sections = sections.filter(([label]) => wanted.has(String(label).split(/\s+/)[0]));
  }
  out.discoveredSections = sections;
  const partial = join(OUT_DIR, 'partial.json');
  for (const [label, id] of sections) {
    const state = await dumpSection(label, id);
    out.sections.push(state);
    writeFileSync(partial, JSON.stringify(out, null, 2));
    console.log(JSON.stringify({
      progress: label,
      fields: state.fields.length,
      tables: state.tables.map((t) => t.rows),
      overLimit: state.overLimitFields.length,
      shortNearLimit: state.shortNearLimitFields.length,
      markdownHits: state.markdownLikeFields.length,
      suspiciousEndings: state.suspiciousEndings.length,
      shot: state.screenshot.path,
    }));
  }
  out.validation = process.env.SKIP_VALIDATION === '1' ? { skipped: true } : await validateOnly();
  out.finishedAt = new Date().toISOString();
  const fp = join(OUT_DIR, 'audit.json');
  writeFileSync(fp, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({
    ok: true,
    out: fp,
    sectionCount: out.sections.length,
    sections: out.sections.map((s) => ({
      label: s.label,
      fields: s.fields.length,
      tables: s.tables.map((t) => t.rows),
      overLimit: s.overLimitFields.length,
      shortNearLimit: s.shortNearLimitFields.length,
      markdownHits: s.markdownLikeFields.length,
      suspiciousEndings: s.suspiciousEndings.length,
      shot: s.screenshot.path,
    })),
    validation: out.validation,
  }, null, 2));
} catch (e) {
  out.error = String(e?.message || e);
  const fp = join(OUT_DIR, 'audit_failed.json');
  writeFileSync(fp, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ok: false, out: fp, error: out.error }, null, 2));
  process.exitCode = 1;
}
