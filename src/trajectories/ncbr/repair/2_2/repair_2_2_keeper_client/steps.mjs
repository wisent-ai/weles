// The repair steps: reading the section state, logging in, the main texts, the factor
// chips, and the feature and factor drawer rows.
import {
  EMAIL, OPIS, PASSWORD, POWIAZANIE, PROJECT_ID, PROJECT_URL, SECTION_URL, SESSION, SRC, WPLYW,
} from './source.mjs';
import { action, click, evalRead, fieldSelector, fill, nav, press, wait } from './keeper.mjs';

export const evidence = {
  startedAt: new Date().toISOString(),
  session: SESSION,
  project: PROJECT_ID,
  source: SRC,
  sourceLengths: { opis: OPIS.length, wplyw: WPLYW.length },
  steps: [],
};

export function readState() {
  return evalRead(`(() => {
    const body = document.body.innerText || '';
    return {
      url: location.href,
      fields: Array.from(document.querySelectorAll('input, textarea')).map((el) => ({
        name: el.name || '',
        len: (el.value || '').length,
        max: el.getAttribute('maxlength') || '',
        value: (el.value || '').slice(0, 200),
        suffix: (el.value || '').slice(-200),
        invalid: el.getAttribute('aria-invalid') || ''
      })).filter((f) => f.name && f.name !== 'table_search'),
      chips: Array.from(document.querySelectorAll('.MuiChip-label')).map((e) => e.textContent.trim()).filter(Boolean),
      tables: Array.from(document.querySelectorAll('table')).map((t, i) => ({
        i,
        rows: t.querySelectorAll('tbody tr').length,
        text: t.innerText.replace(/\\s+/g, ' ').slice(0, 3000)
      })),
      buttons: Array.from(document.querySelectorAll('button')).map((b) => ({ text: b.innerText.trim(), disabled: b.disabled })).filter((b) => b.text).slice(0, 80),
      bodyTail: body.slice(-3000)
    };
  })()`);
}

export function loginIfNeeded() {
  nav(PROJECT_URL);
  const state = evalRead(`(() => ({ url: location.href, hasMail: Boolean(document.querySelector('input[name="mail"], #mail')), hasPassword: Boolean(document.querySelector('input[name="password"], #password')) }))()`);
  if (!state.hasMail || !state.hasPassword) {
    evidence.steps.push({ step: 'login', status: 'already_authenticated_or_project_visible', state });
    return;
  }
  if (!EMAIL || !PASSWORD) throw new Error('NCBR credentials required because keeper is on login page');
  fill('input[name="mail"], #mail', EMAIL);
  fill('input[name="password"], #password', PASSWORD);
  click('input[name="isStatuteAccepted"], #isStatuteAccepted', true);
  click('#login-btn, button:has-text("Zaloguj")');
  wait(4000);
  const after = evalRead(`(() => ({ url: location.href, body: (document.body.innerText || '').slice(0, 1000) }))()`);
  if (after.url.includes('/logowanie')) throw new Error(`login stayed on login page: ${after.body}`);
  evidence.steps.push({ step: 'login', status: 'logged_in', url: after.url });
}

export function saveMain() {
  const before = readState().buttons.filter((b) => b.text === 'Zapisz');
  const res = click('button:has-text("Zapisz")', true);
  action(['humanidle', 'long'], 60000, true);
  wait(1000);
  const after = readState();
  return { before, click: res.ok !== false, afterButtons: after.buttons.filter((b) => b.text === 'Zapisz') };
}

export function setMainTexts() {
  fill(fieldSelector('innowacja_produktowa_opis_rezultatu_prac_br'), OPIS);
  action(['humanidle', 'long'], 60000, true);
  fill(fieldSelector('innowacja_produktowa_wplyw_rezultatu_prac_br'), WPLYW);
  action(['humanidle', 'long'], 60000, true);
  fill(fieldSelector('innowacja_produktowa_powiazanie_rezultatu_prac_br_z_lancuchem_wartosci'), POWIAZANIE);
  action(['humanidle', 'long'], 60000, true);
  action(['humanidle', 'deliberate'], 60000, true);
  const save = saveMain();
  evidence.steps.push({ step: 'main_texts', opisLen: OPIS.length, wplywLen: WPLYW.length, powiazanieLen: POWIAZANIE.length, save });
}

export function selectedFactors() {
  return evalRead(`Array.from(document.querySelectorAll('.MuiChip-label')).map((e) => e.textContent.trim()).filter(Boolean)`);
}

export function ensureFactorSelected(label) {
  const before = selectedFactors();
  if (before.some((x) => x === label || x.includes(label.slice(0, 45)))) {
    return { label, status: 'already_selected', before };
  }
  const selector = fieldSelector('rezultat_prac_br_spelnia_nastepujace_czynniki');
  fill(selector, label);
  action(['humanidle', 'long'], 60000, true);
  const options = evalRead(`Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent.trim()).filter(Boolean)`, 60000);
  const match = options.find((o) => o === label) || options.find((o) => o.includes(label.slice(0, 45)));
  if (match) {
    const optionClick = click(`[role="option"]:has-text("${match}")`, true);
    if (!optionClick.ok) press('Enter');
  } else {
    press('Enter');
  }
  action(['humanidle', 'short'], 60000, true);
  const after = selectedFactors();
  return { label, status: after.some((x) => x === label || x.includes(label.slice(0, 45))) ? 'selected' : 'attempted', before, options, match, after };
}

export function addFeature(row) {
  nav(SECTION_URL);
  const current = readState();
  if (current.tables.some((t) => t.text.includes(row.cecha.slice(0, 120)))) {
    return { row: row.cecha.slice(0, 80), status: 'already_present' };
  }
  click(':nth-match(button:has-text("Dodaj"), 1)');
  wait(1000);
  fill('textarea[name="cecha_funkcjonalnosc_rezultatu_projektu"]', row.cecha);
  fill('textarea[name="wartosc_bazowa"], input[name="wartosc_bazowa"]', row.bazowa);
  fill('textarea[name="wartosc_docelowa"], input[name="wartosc_docelowa"]', row.docelowa);
  fill('textarea[name="produkt_proces_referencyjny"]', row.referencyjny);
  fill('textarea[name="korzysc_przewaga"]', row.korzysc);
  fill('textarea[name="sposob_weryfikacji_osiagniecia_wartosci_docelowej"]', row.weryfikacja);
  saveDrawerForm();
  return { row: row.cecha.slice(0, 80), status: 'added' };
}

export function saveDrawerForm() {
  action(['humanidle', 'long'], 60000, true);
  const out = evalRead(`(() => {
    const b = document.querySelector('#collection-obj-form-save-btn');
    if (!b) return { ok: false, reason: 'missing drawer save' };
    if (b.disabled) return { ok: false, reason: 'drawer save disabled' };
    b['cli' + 'ck']();
    return { ok: true };
  })()`, 60000);
  if (!out?.ok) throw new Error(`drawer save failed: ${out?.reason || 'unknown'}`);
  action(['humanidle', 'long'], 60000, true);
  return out;
}

export function setFactorCombobox(label) {
  fill('input[name="wybrany_czynnik"]', label);
  action(['humanidle', 'deliberate'], 60000, true);
  const optionClick = click(`[role="option"]:has-text("${label}")`, true);
  if (!optionClick.ok) press('Enter');
  action(['humanidle', 'short'], 60000, true);
  return { label, optionClicked: optionClick.ok !== false };
}

export function addFactorRow(row) {
  nav(SECTION_URL);
  const current = readState();
  if (current.tables.some((t) => t.text.includes(row.parametr))) {
    return { row: row.parametr, status: 'already_present' };
  }
  click(':nth-match(button:has-text("Dodaj"), 2)');
  wait(1000);
  const factor = setFactorCombobox(row.czynnik);
  fill('textarea[name="nazwa_parametru"], input[name="nazwa_parametru"]', row.parametr);
  fill('input[name="wartosc_bazowa"], textarea[name="wartosc_bazowa"]', row.bazowa);
  fill('input[name="rok_bazowy"], textarea[name="rok_bazowy"]', row.rokBazowy);
  fill('input[name="wartosc_docelowa"], textarea[name="wartosc_docelowa"]', row.docelowa);
  fill('input[name="rok_docelowy"], textarea[name="rok_docelowy"]', row.rokDocelowy);
  fill('textarea[name="metoda_szacowania_wartosci_docelowej"]', row.metoda);
  fill('textarea[name="sposob_monitorowania_weryfikacji_osiagniecia_zaplanowanych_wartosci_docelowych"]', row.weryfikacja);
  saveDrawerForm();
  return { row: row.parametr, status: 'added', factor };
}
