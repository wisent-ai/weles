// UI-only readback audit for the NCBR STEP B draft.
// Uses an existing keeper session. Never saves, uploads, deletes, withdraws, or submits.

import { mkdirSync, writeFileSync } from 'node:fs';
import { keeperRequest, keeperSocket } from '../../_shared/keeper/client.mjs';

const SESSION = process.env.SESSION || 'ncbr-step-b';
const PROJECT_ID = (await import('#ncbr-settings')).projectId();
const PROJECT_URL = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}`;
const BASE = `${PROJECT_URL}/projekt_step/`;
const OUT_DIR = process.env.OUT_DIR || (await import('#ncbr-settings')).applicationFile('audit_keeper_ui_only');
const EMAIL = process.env.NCBR_EMAIL || '';
const PASSWORD = process.env.NCBR_PASSWORD || '';
delete process.env.NCBR_PASSWORD;

const FALLBACK_SECTIONS = [
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
  ['6.4', (await import('#ncbr-settings')).sectionId('6_4')],
  ['6.5', (await import('#ncbr-settings')).sectionId('6_5')],
  ['8', (await import('#ncbr-settings')).sectionId('8')],
  ['9.1', (await import('#ncbr-settings')).sectionId('9_1')],
  ['9.2', (await import('#ncbr-settings')).sectionId('9_2')],
  ['10.1', (await import('#ncbr-settings')).sectionId('10_1')],
  ['10.2', (await import('#ncbr-settings')).sectionId('10_2')],
  ['10.3', (await import('#ncbr-settings')).sectionId('10_3')],
  ['10.4', (await import('#ncbr-settings')).sectionId('10_4')],
];

mkdirSync(OUT_DIR, { recursive: true });

async function send(cmd) {
  const res = await keeperRequest(keeperSocket(SESSION), cmd);
  if (!res.ok) throw new Error(`${cmd.action} failed: ${res.error}`);
  return res;
}

async function nav(url) {
  const out = await send({ action: 'nav', url });
  await send({ action: 'humanidle', kind: 'long' });
  return out;
}

async function read(js) {
  return (await send({ action: 'eval', js })).result;
}

async function screenshot(label) {
  if (process.env.SKIP_SCREENSHOTS === '1') return { label, path: null };
  const out = await send({ action: 'screenshot' });
  return { label, path: out.path };
}

async function loginIfNeeded() {
  await nav(PROJECT_URL);
  const state = await read(`(() => ({
    url: location.href,
    hasMail: Boolean(document.querySelector('#mail, input[name="mail"]')),
    hasPassword: Boolean(document.querySelector('#password, input[name="password"]')),
    body: document.body.innerText,
  }))()`);
  if (!state.hasMail || !state.hasPassword) return { status: 'already_authenticated_or_project_page', state };
  if (!EMAIL || !PASSWORD) return { status: 'needs_credentials', state };
  await send({ action: 'fill', selector: '#mail, input[name="mail"]', text: EMAIL });
  await send({ action: 'fill', selector: '#password, input[name="password"]', text: PASSWORD });
  const check = await read(`(() => {
    const el = document.querySelector('#isStatuteAccepted, input[name="isStatuteAccepted"]');
    return el ? { present: true, checked: el.checked } : { present: false };
  })()`);
  if (check.present && !check.checked) {
    await send({ action: 'click', selector: '#isStatuteAccepted, input[name="isStatuteAccepted"]' });
  }
  await send({ action: 'click', selector: '#login-btn, button:has-text("Zaloguj")' });
  await send({ action: 'humanidle', kind: 'long' }).catch(() => null);
  await send({ action: 'humanidle', kind: 'long' }).catch(() => null);
  const after = await read(`(() => ({ url: location.href, body: document.body.innerText }))()`);
  return { status: after.url.includes('/logowanie') ? 'still_login_page' : 'logged_in', after };
}

async function discoverSections() {
  await nav(PROJECT_URL);
  const links = await read(`(() => {
    const out = [];
    for (const a of Array.from(document.querySelectorAll('a[href]'))) {
      if (!a.href.includes('/projekt_step/')) continue;
      const id = a.href.split('/projekt_step/')[1]?.split(/[?#/]/)[0];
      const label = (a.textContent || '').trim().replace(/\\s+/g, ' ');
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
        value: raw,
        suffix: raw,
        invalid: el.getAttribute('aria-invalid') || '',
      };
    }).filter((f) => f.name && f.name !== 'table_search');
    const tables = Array.from(document.querySelectorAll('table')).map((table, i) => ({
      i,
      rows: table.querySelectorAll('tbody tr').length,
      text: Array.from(table.querySelectorAll('tbody tr')).map((r) => r.innerText.trim().replace(/\\s+/g, ' ')),
    }));
    return {
      url: location.href,
      title: document.title,
      heading: (document.querySelector('h1,h2,h3')?.textContent || '').trim(),
      body,
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
    await send({ action: 'click', selector: 'button:has-text("Sprawdź wniosek")' });
    clicked = true;
    await send({ action: 'humanidle', kind: 'long' }).catch(() => null);
    await send({ action: 'humanidle', kind: 'long' }).catch(() => null);
  } catch (e) {
    return { clicked, error: String(e?.message || e), screenshot: await screenshot('validation_failed') };
  }
  const state = await read(`(() => {
    const body = document.body.innerText || '';
    return {
      url: location.href,
      dialogs: Array.from(document.querySelectorAll('[role="dialog"], .MuiDialog-root, .MuiAlert-root, .MuiSnackbar-root')).map((e) => e.textContent.trim().replace(/\\s+/g, ' ')).filter(Boolean),
      errorLikeLines: body.split('\\n').map((l) => l.trim()).filter((l) => /błąd|blad|wymagan|uzupeł|niepopraw|nie może|walid|popraw/i.test(l)),
      submitButtons: Array.from(document.querySelectorAll('button')).map((b) => ({ text: b.innerText.trim(), disabled: b.disabled })).filter((b) => /Złóż|Sprawdź|Potwierdzam/i.test(b.text)),
      body,
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
