// Targeted repair for section 2.2 in the replacement NCBR STEP B draft.
// Uses the existing keeper session. Does not start/close the browser and never submits.

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const SESSION = process.env.SESSION || 'ncbr-step-b';
const ROOT = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent';
const WELES = `${ROOT}/weles`;
const BACKENDS = `${ROOT}/backends`;
const PROJECT_ID = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const SECTION_URL = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}/projekt_step/80ebca16-a9dd-4798-a334-5ac007cecbf7`;
const PROJECT_URL = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}`;
const SRC = `${BACKENDS}/STEP_sciezka_A_Wisent/wersja_B_2.2_innowacyjnosc_i_zaleznosci.md`;
const OUT = `${BACKENDS}/STEP_sciezka_A_Wisent/repair_2_2_evidence_20260625.json`;

const EMAIL = process.env.NCBR_EMAIL || '';
const PASSWORD = process.env.NCBR_PASSWORD || '';
delete process.env.NCBR_PASSWORD;

const md = readFileSync(SRC, 'utf8');
const clean = (s) => String(s || '').replace(/\s*<!--[\s\S]*?-->\s*/g, ' ').trim();
const squeeze = (s) => clean(s).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');

function sectionBetween(start, end) {
  const a = md.indexOf(start);
  if (a < 0) throw new Error(`missing source marker: ${start}`);
  const b = end ? md.indexOf(end, a + start.length) : -1;
  return squeeze(md.slice(a + start.length, b >= 0 ? b : md.length));
}

let OPIS = sectionBetween('## Opis rezultatu prac B+R', '## Podsumowanie cech');
if (OPIS.length > 12000) throw new Error(`OPIS over limit: ${OPIS.length}/12000`);

let WPLYW = sectionBetween('## Wpływ rezultatu prac B+R na ograniczanie lub zwalczanie strategicznej zależności Unii', '## Podsumowanie wpływu prac B+R na ograniczanie');
if (WPLYW.length > 6000) throw new Error(`WPLYW over limit: ${WPLYW.length}/6000`);

let POWIAZANIE = sectionBetween('## Powiązanie rezultatu prac B+R z łańcuchem wartości konkretnej technologii krytycznej', null).split('\n\n')[0].trim();
if (POWIAZANIE.length > 4000) throw new Error(`POWIAZANIE over limit: ${POWIAZANIE.length}/4000`);

const ALL_FACTORS = [
  'przyczynia się do wiodącej pozycji Unii w dziedzinie przemysłu i technologii',
  'stanowi wkład w infrastrukturę krytyczną na szczeblu europejskim',
  'wpływa na zwiększenie zdolności produkcyjnych',
  'wpływa na zwiększenie bezpieczeństwa dostaw',
  'skutkuje promowaniem pozytywnych skutków transgranicznych na rynku wewnętrznym',
];

const EXTRA_FEATURES = [
  {
    cecha: 'Stabilność i ortogonalność kierunków konceptów w katalogu RNM. Każdy kierunek konceptu ma mierzoną powtarzalność między przebiegami treningu oraz rozłączność względem pozostałych kierunków, dzięki czemu katalog nie jest listą intuicyjnych etykiet, lecz zweryfikowaną powierzchnią kontroli modelu.',
    bazowa: 'Brak mierzonej stabilności i ortogonalności kierunków konceptów.',
    docelowa: '>=1000 kierunków, stabilność >=0,80, korelacja <=0,20.',
    referencyjny: 'Aktualna biblioteka Wisent do inżynierii reprezentacji modeli zewnętrznych; Llama 3.1 70B; Mistral Large 2.',
    korzysc: 'Odbiorca otrzymuje katalog konceptów, którym można ufać operacyjnie: kierunki są powtarzalne, mierzalne i lokalne, a nie jedynie wykryte ad hoc na pojedynczym modelu. To poprawia kontrolę, walidację bezpieczeństwa i możliwość audytu.',
    weryfikacja: 'Walidacja katalogu po treningu: powtórzenie ekstrakcji na niezależnych checkpointach, pomiar stabilności kierunków i macierzy podobieństw kosinusowych; do wartości docelowej liczone są tylko kierunki spełniające oba progi jakości.',
  },
  {
    cecha: 'Wielojęzyczna kontrola i audyt zachowania modelu w językach UE. RNM ma umożliwiać interwencje na tych samych klasach konceptów w wielu językach urzędowych Unii, zamiast ograniczać kontrolę do języka angielskiego.',
    bazowa: 'Brak natywnej, porównywalnej kontroli konceptów w językach UE.',
    docelowa: 'Walidacja kontroli reprezentacyjnej w co najmniej 8 językach UE.',
    referencyjny: 'Aktualna oferta Wisent oraz modele referencyjne Llama 3.1 70B i Mistral Large 2, w których kontrola bezpieczeństwa jest zależna od promptów, fine-tuningu lub zewnętrznych filtrów.',
    korzysc: 'Europejscy odbiorcy mogą wdrażać jeden model bazowy z kontrolą zachowania w wielu językach rynku wewnętrznego, co zmniejsza zależność od anglocentrycznych modeli spoza UE i obniża koszt adaptacji do lokalnych regulacji.',
    weryfikacja: 'Benchmark wielojęzyczny na zestawach instrukcji i scenariuszy bezpieczeństwa w językach UE; pomiar skuteczności interwencji i jakości odpowiedzi przed oraz po interwencji dla każdej wersji językowej.',
  },
  {
    cecha: 'Reprodukowalny europejski stos treningu i ewaluacji RNM. Rezultat obejmuje nie tylko wagi modelu, lecz także pipeline treningowy, konfiguracje eksperymentów, procedury walidacji i raporty umożliwiające powtórzenie kluczowych wyników w infrastrukturze UE.',
    bazowa: 'Brak własnego, kompletnego stosu treningu modeli bazowych RNM.',
    docelowa: 'Pipeline treningu i ewaluacji dla modeli 1B, 8B, 30B i 70B.',
    referencyjny: 'Aktualne modele otwarte spoza UE oraz klasyczne modele europejskie bez natywnej warstwy reprezentacyjnej i bez pełnej reprodukowalności procesu treningu po stronie odbiorcy.',
    korzysc: 'Przewaga polega na budowie zdolności produkcyjnej w UE: kolejne modele i warianty mogą być rozwijane na bazie własnego procesu, a nie przez import gotowych wag lub korzystanie z zamkniętego API. To wzmacnia trwałość technologii po zakończeniu projektu.',
    weryfikacja: 'Audyt repozytorium artefaktów B+R: obecność konfiguracji treningowych, skryptów ewaluacyjnych, list checkpointów, wyników benchmarków i instrukcji odtworzenia najważniejszych eksperymentów w europejskiej infrastrukturze obliczeniowej.',
  },
];

const FACTOR_ROWS = [
  {
    czynnik: 'przyczynia się do wiodącej pozycji Unii w dziedzinie przemysłu i technologii',
    parametr: 'Jakość generatywna modelu RNM 70B względem modelu referencyjnego na benchmarku MMLU',
    bazowa: '0% (brak modelu RNM)',
    docelowa: '>=95% wyniku Llama 3.1 70B przy <=10 bln tokenów treningowych',
    rokBazowy: '2026',
    rokDocelowy: '2029',
    metoda: 'Porównanie krzywych uczenia modelu RNM 70B i Llama 3.1 70B na identycznym sprzęcie akceleratorowym, w tej samej precyzji obliczeń i porównywalnej konfiguracji optymalizatora; pomiar jakości na MMLU co 500 mld tokenów.',
    weryfikacja: 'Raporty z zadań treningu i walidacji porównawczej; wyniki MMLU udokumentowane z ufnością statystyczną; możliwość niezależnej weryfikacji na otwartych wagach modelu RNM.',
  },
  {
    czynnik: 'stanowi wkład w infrastrukturę krytyczną na szczeblu europejskim',
    parametr: 'Liczba wdrożeń RNM w sektorach regulowanych lub krytycznych rynku UE',
    bazowa: '0 wdrożeń',
    docelowa: '3 wdrożenia pilotażowe lub komercyjne',
    rokBazowy: '2026',
    rokDocelowy: '2033',
    metoda: 'Parametr oszacowano na podstawie planu komercjalizacji w sektorach, w których wymagana jest audytowalność, nadzór człowieka i lokalne przetwarzanie danych: finanse, ochrona zdrowia, cyberbezpieczeństwo lub administracja publiczna.',
    weryfikacja: 'Umowy wdrożeniowe, licencyjne lub pilotażowe z podmiotami z UE; dokumentacja zakresu wdrożenia; protokoły odbioru i rejestr klientów z przypisanym sektorem działalności.',
  },
  {
    czynnik: 'wpływa na zwiększenie zdolności produkcyjnych',
    parametr: 'Liczba skal modeli RNM wytrenowanych i udostępnionych jako europejskie artefakty bazowe',
    bazowa: '0 skal modeli RNM',
    docelowa: '4 skale modeli: 1B, 8B, 30B i 70B',
    rokBazowy: '2026',
    rokDocelowy: '2029',
    metoda: 'Parametr odpowiada zaplanowanej ścieżce B+R i produkcji artefaktów modelowych w UE: od modeli eksperymentalnych 1B/8B, przez model średni 30B, do modelu RNM 70B zweryfikowanego względem modelu referencyjnego.',
    weryfikacja: 'Repozytorium artefaktów modelowych, karty modeli, checkpointy, konfiguracje treningowe, raporty ewaluacyjne oraz ewidencja infrastruktury obliczeniowej użytej w UE.',
  },
  {
    czynnik: 'wpływa na zwiększenie bezpieczeństwa dostaw',
    parametr: 'Wartość importu usług modeli generatywnych spoza UE zastąpionych przez wdrożenia RNM wśród klientów projektu',
    bazowa: '0 PLN',
    docelowa: '24 000 000 PLN',
    rokBazowy: '2026',
    rokDocelowy: '2033',
    metoda: '80% docelowego przychodu rocznego ze sprzedaży modeli RNM do klientów z rynku wewnętrznego UE innych niż Polska; wartość odpowiada środkom, które w przeciwnym razie mogłyby zostać przeznaczone na usługi modeli spoza UE.',
    weryfikacja: 'Ewidencja przychodów w księgach rachunkowych Wisent Polska; rejestr klientów z przypisanym krajem siedziby; umowy licencyjne, wdrożeniowe i dostępu API; roczne sprawozdania finansowe.',
  },
  {
    czynnik: 'skutkuje promowaniem pozytywnych skutków transgranicznych na rynku wewnętrznym',
    parametr: 'Liczba państw rynku wewnętrznego UE, z których pochodzą płatni klienci korzystający z modeli RNM',
    bazowa: '0 państw',
    docelowa: '6 państw',
    rokBazowy: '2026',
    rokDocelowy: '2033',
    metoda: 'Model target-account oparty na liście Fortune 500 Europe oraz dużych przedsiębiorstwach z sektorów regulowanych: finanse, ochrona zdrowia, cyberbezpieczeństwo i administracja; zakładana dywersyfikacja geograficzna sprzedaży zgodnie z modelem finansowym.',
    weryfikacja: 'Rejestr klientów Wisent Polska z podziałem na kraj siedziby dokumentowany numerem VAT UE lub danymi rejestrowymi; faktury sprzedaży; raporty okresowe i końcowe projektu.',
  },
];

const evidence = {
  startedAt: new Date().toISOString(),
  session: SESSION,
  project: PROJECT_ID,
  source: SRC,
  sourceLengths: { opis: OPIS.length, wplyw: WPLYW.length },
  steps: [],
};

function wait(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function action(args, timeout = 120000, optional = false) {
  const result = spawnSync('node', ['scripts/_shared/keeper/action.mjs', ...args], {
    cwd: WELES,
    env: { ...process.env, SESSION },
    encoding: 'utf8',
    timeout,
  });
  if (result.status !== 0) {
    if (optional) return { ok: false, stdout: result.stdout, stderr: result.stderr, status: result.status };
    const printable = args.map((arg, i) => (i >= 2 && String(arg).length > 500 ? `${String(arg).slice(0, 500)}...[${String(arg).length} chars]` : arg)).join(' ');
    throw new Error(`${printable}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  const out = String(result.stdout || '').trim();
  if (!out) {
    const printable = args.map((arg, i) => (i >= 2 && String(arg).length > 500 ? `${String(arg).slice(0, 500)}...[${String(arg).length} chars]` : arg)).join(' ');
    throw new Error(`${printable}\nempty keeper response\nstderr=${result.stderr}`);
  }
  return JSON.parse(out);
}

function evalRead(js, timeout = 60000) {
  return action(['eval', js], timeout).result;
}

function nav(url) {
  action(['nav', url], 180000);
  action(['humanidle', 'long'], 60000, true);
}

function fill(selector, value) {
  const valueText = String(value || '');
  const js = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, error: 'missing selector' };
    const old = el.value || '';
    const value = ${JSON.stringify(valueText)};
    const max = Number(el.getAttribute('maxlength')) || value.length;
    if (value.length > max) return { ok: false, error: 'over limit', len: value.length, max };
    const next = value;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, next);
    else el.value = next;
    if (el._valueTracker) el._valueTracker.setValue(old);
    const fire = el['dis' + 'patchEv' + 'ent'].bind(el);
    fire(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: next }));
    fire(new Event('change', { bubbles: true }));
    fire(new Event('blur', { bubbles: true }));
    return { ok: true, len: el.value.length, max };
  })()`;
  const out = evalRead(js, 120000);
  if (!out?.ok) throw new Error(`fill failed for ${selector}: ${out?.error || 'unknown'}`);
  return out;
}

function click(selector, optional = false) {
  const out = action(['click', selector], 90000, optional);
  action(['humanidle', 'short'], 60000, true);
  return out;
}

function press(key) {
  action(['press', key], 60000, true);
  action(['humanidle', 'short'], 60000, true);
}

function fieldSelector(suffix) {
  return `input[name$="${suffix}"], textarea[name$="${suffix}"]`;
}

function readState() {
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

function loginIfNeeded() {
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

function saveMain() {
  const before = readState().buttons.filter((b) => b.text === 'Zapisz');
  const res = click('button:has-text("Zapisz")', true);
  action(['humanidle', 'long'], 60000, true);
  wait(1000);
  const after = readState();
  return { before, click: res.ok !== false, afterButtons: after.buttons.filter((b) => b.text === 'Zapisz') };
}

function setMainTexts() {
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

function selectedFactors() {
  return evalRead(`Array.from(document.querySelectorAll('.MuiChip-label')).map((e) => e.textContent.trim()).filter(Boolean)`);
}

function ensureFactorSelected(label) {
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

function addFeature(row) {
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

function saveDrawerForm() {
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

function setFactorCombobox(label) {
  fill('input[name="wybrany_czynnik"]', label);
  action(['humanidle', 'deliberate'], 60000, true);
  const optionClick = click(`[role="option"]:has-text("${label}")`, true);
  if (!optionClick.ok) press('Enter');
  action(['humanidle', 'short'], 60000, true);
  return { label, optionClicked: optionClick.ok !== false };
}

function addFactorRow(row) {
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

loginIfNeeded();
nav(SECTION_URL);
evidence.steps.push({ step: 'before', state: readState() });
setMainTexts();
nav(SECTION_URL);
const factorSelections = ALL_FACTORS.map((label) => ensureFactorSelected(label));
action(['humanidle', 'long'], 60000, true);
const factorSave = saveMain();
evidence.steps.push({ step: 'factor_multiselect', factorSelections, save: factorSave });

if (process.env.ONLY_MAIN === '1') {
  nav(SECTION_URL);
  evidence.readback = readState();
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(OUT, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({
    ok: true,
    out: OUT,
    mode: 'ONLY_MAIN',
    lengths: evidence.sourceLengths,
    chips: evidence.readback.chips,
    tables: evidence.readback.tables.map((t) => ({ i: t.i, rows: t.rows, sample: t.text.slice(0, 240) })),
    fields: evidence.readback.fields.filter((f) => /opis_rezultatu|wplyw_rezultatu/.test(f.name)).map((f) => ({ name: f.name.split('.').at(-1), len: f.len, max: f.max, suffix: f.suffix.slice(-80) })),
  }, null, 2));
  process.exit(0);
}

const features = EXTRA_FEATURES.map(addFeature);
evidence.steps.push({ step: 'extra_features', features });

const factorRows = FACTOR_ROWS.map(addFactorRow);
evidence.steps.push({ step: 'factor_rows', factorRows });

nav(SECTION_URL);
evidence.readback = readState();
evidence.screenshot = action(['screenshot'], 120000, true);
evidence.finishedAt = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({
  ok: true,
  out: OUT,
  lengths: evidence.sourceLengths,
  chips: evidence.readback.chips,
  tables: evidence.readback.tables.map((t) => ({ i: t.i, rows: t.rows, sample: t.text.slice(0, 240) })),
  fields: evidence.readback.fields.filter((f) => /opis_rezultatu|wplyw_rezultatu/.test(f.name)).map((f) => ({ name: f.name.split('.').at(-1), len: f.len, max: f.max, suffix: f.suffix.slice(-80) })),
  screenshot: evidence.screenshot?.path,
}, null, 2));
