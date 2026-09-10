// Keeper-socket repair client for the replacement NCBR STEP B draft.
// Uses one existing Weles keeper session. No host cursor, no visible browser restart,
// no LSI direct write API, and never invokes submission.

import net from 'node:net';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSION = process.env.SESSION || 'ncbr-step-b';
const SOCK = join(homedir(), '.weles', 'keeper', SESSION, 'socket');
const PROJECT_ID = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const BASE = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}/projekt_step/`;
const PROJECT_URL = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}`;
const URLS = {
  s22: `${BASE}80ebca16-a9dd-4798-a334-5ac007cecbf7`,
  s63: `${BASE}fb417879-403e-4241-a202-ec23c6a6b866`,
  s65: `${BASE}bdb2c7b3-92d9-4778-9ecc-b4c5bda7d32b`,
  s8: `${BASE}d31b6d68-33b7-45a0-a032-0f5f02b5aed8`,
};

const email = process.env.NCBR_EMAIL || 'lukasz.bartoszcze@gmail.com';
const password = process.env.NCBR_PASSWORD;
if (!password) throw new Error('NCBR_PASSWORD missing');
delete process.env.NCBR_PASSWORD;

const DIRECT_ROWS = [
  {
    candidates: ['Senior Machine Learning Engineer', '1 049 000', '1049000'],
    fields: {
      nazwa_kosztu: 'Senior Machine Learning Engineer RNM (1,0 FTE, 36 mies.)',
      wydatki_ogolem: '1049000.00',
      wydatki_kwalifikowalne: '1049000.00',
      w_tym_vat: '0.00',
      dofinansowanie: '839200.00',
      uzasadnienie_kosztu: 'Koszt obejmuje wyłącznie prace B+R stanowiska Senior Machine Learning Engineer RNM: projektowanie i implementację funkcji celu kształtujących reprezentację, implementację procedur ekstrakcji i kalibracji kierunków konceptów, prowadzenie eksperymentów treningowych, analizę wyników oraz przygotowanie technicznej dokumentacji eksperymentów. Stanowisko nie pełni funkcji kierownika B+R, kierownika projektu, koordynatora ani osoby zarządzającej projektem; nie obejmuje zarządzania administracyjnego, nadzoru właścicielskiego, sprzedaży, raportowania finansowego ani komercjalizacji.',
      metoda_szacowania: 'Kalkulacja: 1,0 FTE x 36 mies. x pełny miesięczny koszt pracodawcy dla senior machine learning engineer / senior ML research engineer. Stawkę oszacowano na podstawie rynkowych widełek wynagrodzeń AI/ML w UE/PL oraz odpowiedzialności za implementację architektury RNM, eksperymenty treningowe i walidację techniczną modeli.',
    },
  },
  {
    candidates: ['Pozostały personel B+R', '4 251 000', '4251000'],
    fields: {
      nazwa_kosztu: 'Pozostały personel B+R - badania przemysłowe (4,25 FTE, 36 mies.)',
      wydatki_ogolem: '4251000.00',
      wydatki_kwalifikowalne: '4251000.00',
      w_tym_vat: '0.00',
      dofinansowanie: '3400800.00',
      uzasadnienie_kosztu: 'Koszt obejmuje stanowiska badawcze i inżynierskie w zadaniach badań przemysłowych: ML Research Scientist, Research Engineer, Data/Evaluation Scientist oraz MLOps Experiment Engineer. Zakres obejmuje projekt eksperymentów, trening modeli, ekstrakcję konceptów, ewaluację i analizę wyników. Nie obejmuje zarządzania administracyjnego, marketingu, sprzedaży ani utrzymania komercyjnego.',
      metoda_szacowania: 'Kalkulacja: 4,25 FTE x 36 miesięcy x średni pełny koszt pracodawcy dla ról ML/R&D. Stawki dobrano według poziomów seniority, stawek rynkowych AI/ML i udziału czasu w zadaniach badawczych. Koszty przypisano proporcjonalnie do zadań badań przemysłowych.',
    },
  },
  {
    candidates: ['Wynajem mocy GPU', '5 000 000', '4 700 000', '3 000 000', '5000000', '4700000'],
    fields: {
      nazwa_kosztu: 'Wynajem mocy GPU do treningu i ewaluacji RNM w zadaniach BP',
      wydatki_ogolem: '5000000.00',
      wydatki_kwalifikowalne: '5000000.00',
      w_tym_vat: '0.00',
      dofinansowanie: '4000000.00',
      uzasadnienie_kosztu: 'Koszt obejmuje wynajem mocy GPU w UE do treningu RNM 1B/8B/30B/70B, treningu dopasowanych modeli referencyjnych, checkpointów, powtórzeń eksperymentów, pomiaru krzywych uczenia, testów skalowania i benchmarków Zadania 2-4. Compute jest używany wyłącznie do eksperymentów B+R, nie do produkcyjnej obsługi klientów, sprzedaży, hostingu usług komercyjnych ani działań marketingowych.',
      metoda_szacowania: 'Szacunek obejmuje około 450 tys. GPU-godzin równoważnika B300/H100/H200 dla treningów skalujących, modeli referencyjnych, powtórzeń i ewaluacji. Kwotę oszacowano na podstawie ofert/on-demand europejskich dostawców GPU, rezerwy na checkpointy i przechowywanie artefaktów oraz konieczności wykonania porównań RNM z transformerem przy tych samych warunkach treningowych.',
    },
  },
  {
    candidates: ['Personel B+R - prace rozwojowe', '2 500 000', '2 200 000', '2500000'],
    fields: {
      nazwa_kosztu: 'Personel B+R - prace rozwojowe: integracja modeli RNM, biblioteka i dokumentacja',
      wydatki_ogolem: '2200000.00',
      wydatki_kwalifikowalne: '2200000.00',
      w_tym_vat: '0.00',
      dofinansowanie: '1320000.00',
      uzasadnienie_kosztu: 'Koszt obejmuje wyłącznie wynagrodzenia personelu B+R wykonującego prace rozwojowe w Zadaniu 5: integrację wyników badań w działającą bibliotekę RNM, przygotowanie narzędzi API, uporządkowanie katalogu konceptów, testy techniczne implementacji, poprawki kodu oraz dokumentację techniczną. Nie obejmuje zewnętrznych pilotaży, publikacji, marketingu, compliance, obsługi klienta ani utrzymania komercyjnego.',
      metoda_szacowania: 'Kalkulacja: 2,15 FTE w okresie prac rozwojowych x pełny koszt pracodawcy ról ML Engineer, Software Engineer i Evaluation Engineer. Stawki oszacowano na podstawie widełek wynagrodzeń AI/software w UE/PL, wymaganego seniority i udziału tych osób w Zadaniu 5.',
    },
  },
];

const INDIRECT_ROWS = [
  {
    candidates: ['Pomoc na badania przemysłowe', '2 575 000', '1 325 000', '2 000 000'],
    fields: {
      wydatki_ogolem: '2575000.00',
      wydatki_kwalifikowalne: '2575000.00',
      dofinansowanie: '2060000.00',
      informacje_o_metodzie_uproszczone: '25%',
      uzasadnienie_kosztu: 'Koszty pośrednie dla badań przemysłowych są wyliczone stawką ryczałtową 25% od bezpośrednich kosztów kwalifikowalnych BP, tj. od 10 300 000,00 zł. Obejmują administrację, księgowość, HR, obsługę prawną, IT support, utrzymanie siedziby, zarządzanie projektem oraz kierownictwo i koordynację prac B+R. Nie są wykazywane jako oddzielne koszty bezpośrednie w 6.3.',
    },
  },
  {
    candidates: ['Pomoc na prace rozwojowe', '550 000', '625 000'],
    fields: {
      wydatki_ogolem: '550000.00',
      wydatki_kwalifikowalne: '550000.00',
      dofinansowanie: '330000.00',
      informacje_o_metodzie_uproszczone: '25%',
      uzasadnienie_kosztu: 'Koszty pośrednie obejmują administrację, księgowość, HR, obsługę prawną, IT support, utrzymanie siedziby i zarządzanie projektem w części przypisanej do prac rozwojowych. Wybrano metodę uproszczoną - stawkę ryczałtową 25% kosztów kwalifikowalnych prac rozwojowych.',
    },
  },
];

const FINANCING_8 = {
  'srodki_wlasne': '0.00',
  'środki własne': '0.00',
  'pozycz': '3675000.00',
  'pożycz': '3675000.00',
  'prywatne': '3675000.00',
  'kredyt': '0.00',
  'inne': '0.00',
};

const evidence = { startedAt: new Date().toISOString(), session: SESSION, project: PROJECT_ID, steps: [] };

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function send(cmd, timeoutMs = 180000) {
  return await new Promise((resolve, reject) => {
    const conn = net.createConnection(SOCK);
    let done = false;
    let buf = '';
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      conn.destroy();
      reject(new Error(`keeper command timed out: ${cmd.action}`));
    }, timeoutMs);
    conn.on('connect', () => conn.write(JSON.stringify(cmd) + '\n'));
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      if (done) return;
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

async function ro(js) {
  return (await send({ action: 'eval', js })).result;
}

async function nav(url) {
  const out = await send({ action: 'nav', url }, 180000);
  await send({ action: 'humanidle', kind: 'long' }, 60000).catch(() => null);
  return out;
}

async function kclick(selector) {
  await send({ action: 'click', selector }, 120000);
  await send({ action: 'humanidle', kind: 'short' }, 60000).catch(() => null);
}

async function kfill(selector, text) {
  await send({ action: 'fill', selector, text }, 240000);
  await send({ action: 'humanidle', kind: 'short' }, 60000).catch(() => null);
}

async function press(key) {
  await send({ action: 'press', key }, 60000);
  await send({ action: 'humanidle', kind: 'short' }, 60000).catch(() => null);
}

function hasText(text) {
  return JSON.stringify(text);
}

async function visibleButtons() {
  return await ro(`Array.from(document.querySelectorAll('button')).map((b,i)=>{const r=b.getBoundingClientRect();return {i,text:b.innerText.trim(),disabled:b.disabled,visible:r.width>0&&r.height>0&&getComputedStyle(b).visibility!=='hidden'&&getComputedStyle(b).display!=='none',x:r.left+r.width/2,y:r.top+r.height/2};}).filter(b=>b.visible)`);
}

async function clickLastButton(label, { requireEnabled = true } = {}) {
  const buttons = (await visibleButtons()).filter((b) => b.text === label && (!requireEnabled || !b.disabled));
  if (!buttons.length) return false;
  const b = buttons[buttons.length - 1];
  await send({ action: 'humanclick', x: b.x, y: b.y }, 120000);
  await send({ action: 'humanidle', kind: 'long' }, 60000).catch(() => null);
  return true;
}

async function saveOpenForm() {
  const buttons = (await visibleButtons()).filter((b) => b.text === 'Zapisz');
  const enabled = buttons.filter((b) => !b.disabled);
  if (!enabled.length) {
    const snapshot = await readVisibleFields();
    await clickLastButton('Anuluj', { requireEnabled: false }).catch(() => null);
    return { status: 'no_enabled_save', buttons, snapshot };
  }
  const b = enabled[enabled.length - 1];
  await send({ action: 'humanclick', x: b.x, y: b.y }, 120000);
  await send({ action: 'humanidle', kind: 'long' }, 60000).catch(() => null);
  await sleep(500);
  return { status: 'saved' };
}

async function readVisibleFields() {
  return await ro(`Array.from(document.querySelectorAll('input,textarea')).map((el)=>{const r=el.getBoundingClientRect();const id=el.id||'';const label=id?document.querySelector('label[for="'+CSS.escape(id)+'"]')?.textContent?.trim():'';return {tag:el.tagName,type:el.getAttribute('type'),name:el.getAttribute('name'),label,value:(el.value||'').slice(0,300),len:(el.value||'').length,readOnly:!!el.readOnly,disabled:!!el.disabled,visible:r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none'};}).filter(x=>x.visible&&x.name)`);
}

async function loginIfNeeded() {
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

async function tableText() {
  return await ro(`Array.from(document.querySelectorAll('table')).map((t,i)=>({i,rows:t.querySelectorAll('tbody tr').length,text:t.innerText.replace(/\\s+/g,' ').slice(0,3000)}))`);
}

async function openEditRow(candidates) {
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

async function fillKnownFields(fields) {
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

async function repairRows(sectionName, url, rows) {
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

async function repair22Factor() {
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

function section8ValueFor(field) {
  const hay = `${field.name || ''} ${field.label || ''}`.toLowerCase();
  for (const [needle, value] of Object.entries(FINANCING_8)) if (hay.includes(needle)) return value;
  if (hay.includes('wspólnot') || hay.includes('wspolnot') || hay.includes('dofinansowanie') || hay.includes('publiczne')) return '11950000.00';
  return null;
}

async function repair8() {
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

async function validate() {
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

await loginIfNeeded();
await repair22Factor();
await repairRows('6.3_direct_rows', URLS.s63, DIRECT_ROWS);
await repairRows('6.5_indirect_rows', URLS.s65, INDIRECT_ROWS);
await repair8();
await validate();

evidence.finishedAt = new Date().toISOString();
const outPath = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/keeper_budget_repair_evidence_20260624.json';
writeFileSync(outPath, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ ok: true, outPath, lastStep: evidence.steps.at(-1) }, null, 2));
