// The repairs: logging in, the 2.2 factor, the 6.3 and 6.5 rows, section 8 and the
// validation readback.
import { FINANCING_8 } from './rows.mjs';
import { PROJECT_URL, URLS, email, evidence, password } from './settings.mjs';
import { clickLastButton, hasText, kclick, kfill, nav, press, readVisibleFields, ro, saveOpenForm, send, sleep } from './keeper.mjs';

export async function loginIfNeeded() {
  await nav('https://lsi2.ncbr.gov.pl/logowanie');
  const info = await ro(`({url:location.href, hasMail:!!document.querySelector('input[name="mail"],#mail'), hasPassword:!!document.querySelector('input[name="password"],#password')})`);
  if (!info.hasMail || !info.hasPassword) {
    evidence.steps.push({ step: 'login', status: 'already_authenticated', info });
    return;
  }
  await kfill('input[name="mail"], #mail', email);
  await kfill('input[name="password"], #password', password);
  const checkbox = await ro(`(()=>{const c=document.querySelector('input[name="isStatuteAccepted"],#isStatuteAccepted');return c?{checked:c.checked,visible:!!(c.offsetWidth||c.offsetHeight||c.getClientRects().length)}:null;})()`);
  if (checkbox && !checkbox.checked) await kclick('input[name="isStatuteAccepted"], #isStatuteAccepted');
  await kclick('#login-btn, button:has-text("Zaloguj")');
  for (let i = 0; i < 10; i += 1) {
    await sleep(1000);
    const u = (await send({ action: 'url' })).url;
    if (!u.includes('/logowanie')) {
      evidence.steps.push({ step: 'login', status: 'ok', url: u });
      return;
    }
  }
  const body = await ro(`document.body.innerText.slice(0,800)`);
  throw new Error(`login stayed on login page: ${body}`);
}

export async function tableText() {
  return await ro(`Array.from(document.querySelectorAll('table')).map((t,i)=>({i,rows:t.querySelectorAll('tbody tr').length,text:t.innerText.replace(/\\s+/g,' ').slice(0,3000)}))`);
}

export async function openEditRow(candidates) {
  const tried = [];
  for (const candidate of candidates) {
    const sel = `tr:has-text(${hasText(candidate)}) button[aria-label="overflow-options"]`;
    tried.push(sel);
    try {
      await kclick(sel);
      await kclick(`[role="menuitem"]:has-text("Edytuj"), .MuiMenuItem-root:has-text("Edytuj")`);
      await sleep(800);
      return { candidate };
    } catch (e) {
      tried.push(`miss:${candidate}:${String(e.message).slice(0, 80)}`);
    }
  }
  throw new Error(`row edit menu not found; tried ${tried.join(' | ')}`);
}

export async function fillKnownFields(fields) {
  const before = await readVisibleFields();
  const filled = [];
  for (const [name, value] of Object.entries(fields)) {
    const selector = `input[name="${name}"], textarea[name="${name}"], input[name$="${name}"], textarea[name$="${name}"]`;
    try {
      await kfill(selector, value);
      filled.push({ name, status: 'filled', len: String(value).length });
    } catch (e) {
      filled.push({ name, status: 'not_found_or_locked', error: String(e.message).slice(0, 160) });
    }
  }
  const after = await readVisibleFields();
  return { before, filled, after };
}

export async function repairRows(sectionName, url, rows) {
  const out = [];
  for (const row of rows) {
    await nav(url);
    const tableBefore = await tableText();
    let edit;
    try {
      edit = await openEditRow(row.candidates);
      const fill = await fillKnownFields(row.fields);
      const save = await saveOpenForm();
      out.push({ candidates: row.candidates, edit, fill, save });
    } catch (e) {
      out.push({ candidates: row.candidates, error: String(e.message), tableBefore });
    }
  }
  evidence.steps.push({ step: sectionName, rows: out });
  return out;
}

export async function repair22Factor() {
  await nav(URLS.s22);
  const inputSel = 'input[name$="rezultat_prac_br_spelnia_nastepujace_czynniki"]';
  const before = await readVisibleFields();
  let picked = null;
  try {
    await kfill(inputSel, 'wpływa na zwiększenie bezpieczeństwa dostaw');
    const options = await ro(`Array.from(document.querySelectorAll('[role="option"]')).map(o=>o.textContent.trim()).filter(Boolean).slice(0,20)`);
    const exact = options.find((o) => /bezpieczeństwa dostaw/i.test(o));
    if (exact) {
      await kclick(`[role="option"]:has-text(${hasText(exact)})`);
      picked = exact;
    } else {
      await press('Enter');
      picked = 'Enter';
    }
    await sleep(700);
    const save = await saveOpenForm();
    evidence.steps.push({ step: '2.2_factor', before, picked, save });
  } catch (e) {
    evidence.steps.push({ step: '2.2_factor', error: String(e.message), before });
  }
}

export function section8ValueFor(field) {
  const hay = `${field.name || ''} ${field.label || ''}`.toLowerCase();
  for (const [needle, value] of Object.entries(FINANCING_8)) if (hay.includes(needle)) return value;
  if (hay.includes('wspólnot') || hay.includes('wspolnot') || hay.includes('dofinansowanie') || hay.includes('publiczne')) return '11950000.00';
  return null;
}

export async function repair8() {
  await nav(URLS.s8);
  const tableBefore = await tableText();
  let mode = 'edit_existing';
  try {
    await openEditRow(['Wisent Polska', 'WISENT POLSKA', '3515000', '3 515 000']);
  } catch {
    mode = 'add';
    await clickLastButton('Dodaj');
    await sleep(1000);
  }
  const before = await readVisibleFields();
  const fills = [];
  for (const f of before) {
    if (!f.name || f.readOnly || f.disabled) continue;
    const v = section8ValueFor(f);
    if (v === null) continue;
    try {
      await kfill(`input[name="${f.name}"], textarea[name="${f.name}"]`, v);
      fills.push({ name: f.name, label: f.label, value: v, status: 'filled' });
    } catch (e) {
      fills.push({ name: f.name, label: f.label, value: v, status: 'error', error: String(e.message).slice(0, 120) });
    }
  }
  const after = await readVisibleFields();
  const save = await saveOpenForm();
  await nav(URLS.s8);
  const tableAfter = await tableText();
  evidence.steps.push({ step: '8_financing', mode, tableBefore, before, fills, after, save, tableAfter });
}

export async function validate() {
  await nav(PROJECT_URL);
  const before = await ro(`document.body.innerText.slice(0,2500)`);
  let clicked = false;
  try {
    clicked = await clickLastButton('Sprawdź wniosek');
  } catch (e) {
    evidence.steps.push({ step: 'validate_click_error', error: String(e.message) });
  }
  await sleep(7000);
  const after = await ro(`document.body.innerText.slice(0,8000)`);
  const url = (await send({ action: 'url' })).url;
  evidence.steps.push({ step: 'validate', clicked, url, beforeSnippet: before.slice(0, 1000), afterSnippet: after });
}
