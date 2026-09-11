// What the audit reads from the application: the login state, a section's visible form,
// the documents list, the validation result and the current page.
import { BASE, EMAIL, PASSWORD, PROJECT_URL } from './settings.mjs';
import { nav, read, send, shot } from './keeper.mjs';

export async function loginIfNeeded() {
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

export async function dumpSection(label, id) {
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

export async function inspectDocuments() {
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

export async function validateOnly() {
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

export async function dumpCurrent(label) {
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

export async function navigateByVisibleLabel(label) {
  await nav(PROJECT_URL);
  await send({ action: 'click', selector: `text=${JSON.stringify(label)}` }, 120000);
  await send({ action: 'humanidle', kind: 'long' }, 60000).catch(() => null);
  return await dumpCurrent(label);
}
