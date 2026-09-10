// Read-only keeper audit for the replacement NCBR STEP B draft.
// Uses existing keeper session only. Never saves, uploads, deletes, withdraws, or submits.

import net from 'node:net';
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSION = process.env.SESSION || 'ncbr-step-b';
const SOCK = join(homedir(), '.weles', 'keeper', SESSION, 'socket');
const PROJECT_ID = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const PROJECT_URL = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}`;
const BASE = `${PROJECT_URL}/projekt_step/`;
const OUT_DIR = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/audit_keeper_readonly_20260625';
const EMAIL = process.env.NCBR_EMAIL || '';
const PASSWORD = process.env.NCBR_PASSWORD || '';
delete process.env.NCBR_PASSWORD;

const SECTIONS = [
  ['1.3', '317a21dd-e798-4115-ab53-6ab5a2912fb0'],
  ['1.4', '4a6e9d5d-10e7-4436-8fd8-728a8e8b8ddc'],
  ['2.1', 'c048ab30-3dda-4228-bf71-4ec6904cffda'],
  ['2.2', '80ebca16-a9dd-4798-a334-5ac007cecbf7'],
  ['2.3', 'c5dbdc83-5baf-4866-b3d8-4da3ae553865'],
  ['2.4', '94fb1adb-38a5-4949-b4c1-b0a79472bfd3'],
  ['6.1', '566c735c-8ad0-406f-a948-f3ea921c2cc7'],
  ['6.3', 'fb417879-403e-4241-a202-ec23c6a6b866'],
  ['6.4', '7f63b840-57b3-4e73-9fb0-91c6f24cad44'],
  ['6.5', 'bdb2c7b3-92d9-4778-9ecc-b4c5bda7d32b'],
  ['8', 'd31b6d68-33b7-45a0-a032-0f5f02b5aed8'],
  ['9.2', 'e95d0c23-8a39-4d56-96fa-ace3e4f0d23a'],
  ['10.4', '4e260fae-c455-41ce-bba3-d0df2a8767fd'],
];

mkdirSync(OUT_DIR, { recursive: true });

function send(cmd, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(SOCK);
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

async function shot(label) {
  const s = await send({ action: 'screenshot' }, 120000);
  return { label, path: s.path };
}

async function loginIfNeeded() {
  await nav(PROJECT_URL);
  const state = await read(`(() => ({
    url: location.href,
    hasMail: Boolean(document.querySelector('#mail, input[name="mail"]')),
    hasPassword: Boolean(document.querySelector('#password, input[name="password"]')),
    body: (document.body.innerText || '').slice(0, 800),
  }))()`);
  if (!state.hasMail || !state.hasPassword) return { status: 'already_authenticated_or_other_page', state };
  if (!EMAIL || !PASSWORD) return { status: 'needs_credentials', state };

  await send({ action: 'fill', selector: '#mail, input[name="mail"]', text: EMAIL }, 120000);
  await send({ action: 'humanidle', kind: 'short' }, 60000).catch(() => null);
  await send({ action: 'fill', selector: '#password, input[name="password"]', text: PASSWORD }, 120000);
  await send({ action: 'humanidle', kind: 'short' }, 60000).catch(() => null);
  const check = await read(`(() => {
    const c = document.querySelector('#isStatuteAccepted, input[name="isStatuteAccepted"]');
    return c ? { present: true, checked: c.checked } : { present: false };
  })()`);
  if (check.present && !check.checked) {
    await send({ action: 'click', selector: '#isStatuteAccepted, input[name="isStatuteAccepted"]' }, 120000);
    await send({ action: 'humanidle', kind: 'short' }, 60000).catch(() => null);
  }
  await send({ action: 'click', selector: '#login-btn, button:has-text("Zaloguj")' }, 120000);
  await send({ action: 'humanidle', kind: 'long' }, 60000).catch(() => null);
  await send({ action: 'humanidle', kind: 'long' }, 60000).catch(() => null);
  const after = await read(`(() => ({ url: location.href, body: (document.body.innerText || '').slice(0, 1000) }))()`);
  return { status: after.url.includes('/logowanie') ? 'still_login_page' : 'logged_in', after };
}

async function dumpSection(label, id) {
  await nav(`${BASE}${id}`);
  const state = await read(`(() => {
    const body = document.body.innerText || '';
    const tables = Array.from(document.querySelectorAll('table')).map((table, i) => ({
      i,
      rows: table.querySelectorAll('tbody tr').length,
      text: Array.from(table.querySelectorAll('tbody tr')).map((r) => r.innerText.trim().replace(/\\s+/g, ' ').slice(0, 800)),
    }));
    const fields = Array.from(document.querySelectorAll('input, textarea, select')).map((el) => {
      const id = el.id || '';
      const lab = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]')?.textContent?.trim() : '';
      const raw = el.value || '';
      return {
        tag: el.tagName,
        type: el.getAttribute('type') || '',
        name: el.getAttribute('name') || '',
        label: lab || '',
        value: raw.slice(0, 500),
        suffix: raw.slice(-500),
        len: raw.length,
        max: el.getAttribute('maxlength') || '',
        invalid: el.getAttribute('aria-invalid') || '',
      };
    }).filter((f) => f.name && f.name !== 'table_search');
    return {
      url: location.href,
      title: document.title,
      bodyHead: body.slice(0, 3000),
      bodyTail: body.slice(-3000),
      fileInputs: Array.from(document.querySelectorAll('input[type="file"]')).map((e) => ({ name: e.name, accept: e.accept, multiple: e.multiple })),
      buttons: Array.from(document.querySelectorAll('button')).map((b) => ({ text: b.innerText.trim(), disabled: b.disabled })).filter((b) => b.text).slice(0, 120),
      tables,
      fields,
      markdownLikeFields: fields.filter((f) => /(\\*\\*|#{1,6}\\s|\\(limit\\s*\\d|<!--|\\|---)/i.test(f.value) || /(\\*\\*|#{1,6}\\s|\\(limit\\s*\\d|<!--|\\|---)/i.test(f.suffix)),
      suspiciousEndings: fields.filter((f) => f.len > 100 && !/[.!?…:;)"”\\]]$/.test(String(f.suffix).trim())).map((f) => ({ name: f.name, label: f.label, len: f.len, suffix: f.suffix.slice(-220) })),
    };
  })()`);
  const screenshot = await shot(label);
  return { label, ...state, screenshot };
}

async function inspectDocuments() {
  await nav(PROJECT_URL);
  await send({ action: 'click', selector: 'button:has-text("Dokumenty"), a:has-text("Dokumenty"), [role="button"]:has-text("Dokumenty")' }, 120000);
  await send({ action: 'humanidle', kind: 'long' }, 60000).catch(() => null);
  const state = await read(`(() => {
    const body = document.body.innerText || '';
    return {
      url: location.href,
      body: body.slice(0, 12000),
      tables: Array.from(document.querySelectorAll('table')).map((table, i) => ({
        i,
        rows: table.querySelectorAll('tbody tr').length,
        text: Array.from(table.querySelectorAll('tbody tr')).map((r) => r.innerText.trim().replace(/\\s+/g, ' ').slice(0, 900)),
      })),
      fileInputs: Array.from(document.querySelectorAll('input[type="file"]')).map((e) => ({ name: e.name, accept: e.accept, multiple: e.multiple })),
      links: Array.from(document.querySelectorAll('a[href]')).map((a) => ({ text: a.textContent.trim().replace(/\\s+/g, ' ').slice(0, 180), href: a.href })).slice(0, 80),
    };
  })()`);
  return { ...state, screenshot: await shot('documents') };
}

async function validateOnly() {
  await nav(PROJECT_URL);
  await send({ action: 'click', selector: 'button:has-text("Sprawdź wniosek")' }, 120000);
  await send({ action: 'humanidle', kind: 'long' }, 60000).catch(() => null);
  await send({ action: 'humanidle', kind: 'long' }, 60000).catch(() => null);
  const state = await read(`(() => {
    const body = document.body.innerText || '';
    return {
      url: location.href,
      dialogs: Array.from(document.querySelectorAll('[role="dialog"], .MuiDialog-root, .MuiAlert-root, .MuiSnackbar-root')).map((e) => e.textContent.trim().replace(/\\s+/g, ' ')).filter(Boolean).slice(0, 40),
      errorLikeLines: body.split('\\n').map((l) => l.trim()).filter((l) => /błąd|blad|wymagan|uzupeł|niepopraw|nie może|walid|popraw/i.test(l)).slice(0, 120),
      buttons: Array.from(document.querySelectorAll('button')).map((b) => ({ text: b.innerText.trim(), disabled: b.disabled })).filter((b) => b.text).slice(0, 120),
      bodyTail: body.slice(-5000),
    };
  })()`);
  return { ...state, screenshot: await shot('validation') };
}

async function dumpCurrent(label) {
  const state = await read(`(() => {
    const body = document.body.innerText || '';
    return {
      url: location.href,
      bodyHead: body.slice(0, 5000),
      bodyTail: body.slice(-5000),
      tables: Array.from(document.querySelectorAll('table')).map((table, i) => ({
        i,
        rows: table.querySelectorAll('tbody tr').length,
        text: Array.from(table.querySelectorAll('tbody tr')).map((r) => r.innerText.trim().replace(/\\s+/g, ' ').slice(0, 1000)),
      })),
      fields: Array.from(document.querySelectorAll('input, textarea, select')).map((el) => ({
        tag: el.tagName,
        type: el.getAttribute('type') || '',
        name: el.getAttribute('name') || '',
        value: (el.value || '').slice(0, 500),
        suffix: (el.value || '').slice(-500),
        len: (el.value || '').length,
        max: el.getAttribute('maxlength') || '',
        invalid: el.getAttribute('aria-invalid') || '',
      })).filter((f) => f.name && f.name !== 'table_search'),
      buttons: Array.from(document.querySelectorAll('button')).map((b) => ({ text: b.innerText.trim(), disabled: b.disabled })).filter((b) => b.text).slice(0, 120),
    };
  })()`);
  return { label, ...state, screenshot: await shot(label) };
}

async function navigateByVisibleLabel(label) {
  await nav(PROJECT_URL);
  await send({ action: 'click', selector: `text=${JSON.stringify(label)}` }, 120000);
  await send({ action: 'humanidle', kind: 'long' }, 60000).catch(() => null);
  return await dumpCurrent(label);
}

const out = {
  projectId: PROJECT_ID,
  startedAt: new Date().toISOString(),
  keeperSession: SESSION,
  sections: [],
  documents: null,
  validation: null,
};

try {
  out.current = await send({ action: 'url' }, 30000);
  out.login = await loginIfNeeded();
  if (out.login.status === 'needs_credentials' || out.login.status === 'still_login_page') {
    throw new Error(`login failed: ${out.login.status}`);
  }
  if (process.env.NAV_LABEL) {
    const state = await navigateByVisibleLabel(process.env.NAV_LABEL);
    if (process.env.EDIT_ROW_TEXT) {
      await send({ action: 'click', selector: `tr:has-text(${JSON.stringify(process.env.EDIT_ROW_TEXT)}) button[aria-label="overflow-options"]` }, 120000);
      await send({ action: 'humanidle', kind: 'deliberate' }, 60000).catch(() => null);
      await send({ action: 'click', selector: `text="Edytuj"` }, 120000);
      await send({ action: 'humanidle', kind: 'long' }, 60000).catch(() => null);
      const editState = await dumpCurrent(`${process.env.NAV_LABEL}__edit`);
      await send({ action: 'click', selector: `button:has-text("Anuluj")` }, 120000).catch(() => null);
      await send({ action: 'humanidle', kind: 'short' }, 60000).catch(() => null);
      const fp = join(OUT_DIR, `edit_${String(process.env.EDIT_ROW_TEXT).replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 80)}.json`);
      writeFileSync(fp, JSON.stringify({ ...out, nav: state, edit: editState }, null, 2));
      console.log(JSON.stringify({
        ok: true,
        out: fp,
        url: editState.url,
        fields: editState.fields.map((f) => ({ name: f.name, type: f.type, len: f.len, value: f.value, suffix: f.suffix })).slice(0, 100),
        buttons: editState.buttons.filter((b) => /Zapisz|Anuluj/i.test(b.text)),
        shot: editState.screenshot.path,
      }, null, 2));
      process.exit(0);
    }
    const fp = join(OUT_DIR, `nav_${String(process.env.NAV_LABEL).replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 80)}.json`);
    writeFileSync(fp, JSON.stringify({ ...out, nav: state }, null, 2));
    console.log(JSON.stringify({
      ok: true,
      out: fp,
      url: state.url,
      tables: state.tables.map((t) => ({ i: t.i, rows: t.rows, text: t.text.join(' || ').slice(0, 1800) })),
      fields: state.fields.map((f) => ({ name: f.name, len: f.len, value: f.value.slice(0, 140), suffix: f.suffix.slice(-140) })).slice(0, 80),
      buttons: state.buttons.filter((b) => /Złóż|Sprawdź|Zapisz/i.test(b.text)),
      shot: state.screenshot.path,
    }, null, 2));
    process.exit(0);
  }
  if (process.env.META === '1') {
    await nav(PROJECT_URL);
    const meta = await read(`(async () => {
      async function fetchText(path) {
        const res = await fetch('https://lsi2.ncbr.gov.pl' + path, { credentials: 'include', headers: { Accept: 'application/json' } });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch {}
        return { status: res.status, text: text.slice(0, 2000), data };
      }
      const links = Array.from(document.querySelectorAll('a[href], [href]')).map((a) => ({
        text: (a.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 160),
        href: a.href || a.getAttribute('href') || '',
      })).filter((x) => x.href.includes('/projekt_step/'));
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).map((b) => (b.textContent || '').trim().replace(/\\s+/g, ' ')).filter(Boolean);
      return {
        url: location.href,
        links,
        buttons,
        project: await fetchText('/api/beneficiary/project/${PROJECT_ID}'),
        projectsPlural: await fetchText('/api/beneficiary/projects/${PROJECT_ID}'),
        resources: performance.getEntriesByType('resource').map((e) => e.name).filter((name) => /project|section|version|APPLICATION_DATA/i.test(name)).slice(-120),
      };
    })()`);
    const fp = join(OUT_DIR, 'meta.json');
    writeFileSync(fp, JSON.stringify({ ...out, meta }, null, 2));
    console.log(JSON.stringify({ ok: true, out: fp, linkCount: meta.links.length, buttons: meta.buttons.slice(0, 80), resourceCount: meta.resources.length }, null, 2));
    process.exit(0);
  }
  for (const [label, id] of SECTIONS) out.sections.push(await dumpSection(label, id));
  out.documents = await inspectDocuments();
  out.validation = await validateOnly();
  out.finishedAt = new Date().toISOString();
  const fp = join(OUT_DIR, 'audit.json');
  writeFileSync(fp, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({
    ok: true,
    out: fp,
    sections: out.sections.map((s) => ({ label: s.label, tables: s.tables.map((t) => t.rows), markdownHits: s.markdownLikeFields.length, suspiciousEndings: s.suspiciousEndings.length, shot: s.screenshot.path })),
    documents: { rows: out.documents.tables.map((t) => t.rows), fileInputs: out.documents.fileInputs, shot: out.documents.screenshot.path },
    validation: { dialogs: out.validation.dialogs, errorLikeLines: out.validation.errorLikeLines, buttons: out.validation.buttons.filter((b) => /Złóż|Sprawdź|Potwierdzam/i.test(b.text)), shot: out.validation.screenshot.path },
  }, null, 2));
} catch (e) {
  out.error = String(e?.message || e);
  const fp = join(OUT_DIR, 'audit_failed.json');
  writeFileSync(fp, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ok: false, out: fp, error: out.error }, null, 2));
  process.exitCode = 1;
}
