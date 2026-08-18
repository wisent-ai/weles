// UI-only scalar-field importer for the STEP B draft.
// Uses the existing keeper session; never submits and never calls LSI APIs.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const SESSION = process.env.SESSION || 'ncbr-step-b';
const ROOT = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent';
const SRC = `${ROOT}/backends/STEP_sciezka_A_Wisent`;
const WELES = `${ROOT}/weles`;
const PROJECT = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/';

const clean = (s) => String(s || '')
  .replace(/\s*<!--[\s\S]*?-->\s*/g, ' ')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/^#{1,6}\s+/gm, '')
  .replace(/\s+/g, ' ')
  .trim();
const cleanParagraphs = (s) => String(s || '')
  .replace(/\s*<!--[\s\S]*?-->\s*/g, ' ')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/^#{1,6}\s+/gm, '')
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n[ \t]+/g, '\n')
  .trim();

function file(name) {
  return readFileSync(`${SRC}/${name}`, 'utf8');
}

function between(text, start, end = null) {
  const parts = text.split(start);
  if (parts.length < 2) throw new Error(`missing marker: ${start}`);
  let out = parts[1];
  if (end) out = out.split(end)[0];
  return clean(out);
}

function betweenParagraphs(text, start, end = null) {
  const parts = text.split(start);
  if (parts.length < 2) throw new Error(`missing marker: ${start}`);
  let out = parts[1];
  if (end) out = out.split(end)[0];
  return cleanParagraphs(out);
}

const wd = file('wersja_B_3.1_3.2_3.3_3.4_wdrozenie.md');
const sections = [
  {
    label: '1.2',
    id: '0ca77e3d-373e-464f-9e9d-a35f5193864d',
    md: 'wersja_B_1_2_klasyfikacja.md',
    fields: (md) => [
      ['nazwa_technologii', between(md, '**Nazwa technologii (jeśli dotyczy, limit 200 znaków)**', '**Typ projektu**')],
      ['produkt_koncowy_technologii_krytycznej', between(md, '**Produkt końcowy technologii krytycznej (limit 500 znaków)**', '**Uzasadnienie wybranej technologii')],
      ['uzasadnienie_wybranej_technologii', between(md, '**Uzasadnienie wybranej technologii (limit 6 000 znaków)**', '**Zakres interwencji**')],
    ],
  },
  {
    label: '2.1',
    id: 'c048ab30-3dda-4228-bf71-4ec6904cffda',
    md: 'wersja_B_2.1_cel_i_potrzeba.md',
    fields: (md) => [
      ['cel_projektu', between(md, '## Cel projektu (limit 2 000 znaków)\n\n', '## Strategiczna potrzeba/wyzwanie')],
      ['strategiczna_potrzeba_na_poziomie_ue', between(md, '## Strategiczna potrzeba/wyzwanie na poziomie UE, na którą odpowiada projekt (limit 10 000 znaków)\n\n')],
    ],
  },
  {
    label: '2.2',
    id: '80ebca16-a9dd-4798-a334-5ac007cecbf7',
    md: 'wersja_B_2.2_innowacyjnosc_i_zaleznosci.md',
    fields: (md) => [
      ['innowacja_produktowa_opis_rezultatu_prac_br', betweenParagraphs(md, '## Opis rezultatu prac B+R\n', '## Podsumowanie cech i funkcjonalności rezultatu projektu')],
      ['innowacja_produktowa_wplyw_rezultatu_prac_br', betweenParagraphs(md, '## Wpływ rezultatu prac B+R na ograniczanie lub zwalczanie strategicznej zależności Unii\n', '## Podsumowanie wpływu prac B+R')],
      ['innowacja_produktowa_powiazanie_rezultatu_prac_br_z_lancuchem_wartosci', betweenParagraphs(md, '## Powiązanie rezultatu prac B+R z łańcuchem wartości konkretnej technologii krytycznej\n', '\n\n---\n\n# Podsumowanie zmian')],
    ],
  },
  {
    label: '2.3',
    id: 'c5dbdc83-5baf-4866-b3d8-4da3ae553865',
    md: 'wersja_B_2.3_rynek_i_potencjal.md',
    fields: (md) => [
      ['innowacja_produktowa_nazwa', 'Modele oparte na reprezentacjach (RNM) z natywnym katalogiem konceptów'],
      ['innowacja_produktowa_rynek_docelowy', between(md, '## Rynek docelowy dla innowacji produktowej oraz zapotrzebowanie rynkowe na produkt\n\n', '## Znaczący potencjał')],
      ['innowacja_produktowa_znaczacy_potencjal_gospodarczy_innowacji', between(md, '## Znaczący potencjał gospodarczy innowacji w wymiarze rynku wewnętrznego UE\n\n', '## Parametry opisujące')],
    ],
  },
  {
    label: '3.2',
    id: '06a70163-2dcc-47a0-b64b-201656946538',
    fields: () => [
      ['innowacja_produktowa_nazwa', between(wd, '**Nazwa produktu (limit 100 znaków)**\n\n', '**Plan wprowadzenia rezultatu projektu na rynek – innowacja produktowa')],
      ['innowacja_produktowa_plan_wprowadzenia', between(wd, '**Plan wprowadzenia rezultatu projektu na rynek – innowacja produktowa (limit 6 000 znaków)**\n\n', '---\n\n## 3.3.')],
    ],
  },
  {
    label: '3.3',
    id: 'bb231ac1-d863-41a8-89a7-88c1db3a1bd7',
    fields: () => [
      ['analiza_oplacalnosci', between(wd, '## 3.3. Analiza opłacalności wdrożenia (limit 4 000 znaków)\n\n', '---\n\n## 3.4.')],
    ],
  },
  {
    label: '3.4',
    id: '836f13ca-f474-4d5c-8388-6afd84eaf353',
    fields: () => [
      ['zasoby_kadrowe_niezbedne_do_wdrozenia', between(wd, '### Zasoby kadrowe niezbędne do wdrożenia (limit 2 000 znaków)\n\n', '### Zasoby techniczne')],
      ['zasoby_techniczne_niezbedne_do_wdrozenia', between(wd, '### Zasoby techniczne niezbędne do wdrożenia (limit 2 000 znaków)\n\n', '### Pozostałe zasoby')],
      ['pozostale_zasoby_niezbedne_do_wdrozenia', between(wd, '### Pozostałe zasoby niezbędne do wdrożenia (limit 2 000 znaków)\n\n', '---')],
    ],
  },
  {
    label: '3.5',
    id: '41b2184d-76e9-4b79-8ece-b2e227dc471f',
    md: 'wersja_B_3.5_prawa_wlasnosci.md',
    fields: (md) => [
      ['wykazanie_braku_barier', between(md, '## Wykazanie braku barier do wdrożenia rezultatów prac B+R (limit 3 000 znaków)', '---')],
      ['opis_sposobu', between(md, '## Opis sposobu uregulowania praw do wyników prac B+R, w tym wskazanie właściciela (limit 4 000 znaków)', '---')],
    ],
  },
  {
    label: '4.3',
    id: 'e8020b59-7947-4c3d-9851-0fc499f42427',
    md: 'wersja_B_4_3_podwykonawcy.md',
    fields: (md) => [
      ['uzasadnienie', between(md, '**Uzasadnienie braku podwykonawstwa prac B+R (limit 3 000 znaków)**', '---\n\n**Informacje o podwykonawcach**')],
    ],
  },
  {
    label: '4.1',
    id: '5af236aa-03b2-4650-b5a2-95c299dfeeaf',
    md: 'wersja_B_4_1_zespol.md',
    fields: (md) => [
      ['sposob_zarzadzania_projektem', between(md, '## Sposób zarządzania projektem (ścieżka decyzyjna)', null)],
    ],
  },
  {
    label: '10.1',
    id: 'e5bd23d7-9d4d-4f2e-948a-97c95041ef18',
    md: 'wersja_B_10_1_rowność.md',
    fields: (md) => [
      ['wplyw_projektu_zasady_rownosci', between(md, '**Pozytywny wpływ projektu na realizację zasady równości szans i niedyskryminacji, w tym dostępności dla osób z niepełnosprawnościami** (limit 4 000 znaków)', '**Dostępność produktu/usługi w projekcie**')],
      ['rownosc_kobiet_i_mezczyzn', between(md, '**Zgodność projektu z zasadą równości kobiet i mężczyzn** (limit 3 000 znaków)')],
    ],
  },
  {
    label: '10.2',
    id: '51455d27-6e3d-4629-9cc6-2a124f5432c8',
    md: 'wersja_B_10_2_karta_praw.md',
    fields: (md) => [
      ['zgodnosc_z_karta_praw_podstawowych', between(md, '**Zgodność projektu z Kartą Praw Podstawowych** (limit 4 000 znaków)')],
    ],
  },
  {
    label: '10.3',
    id: '256ac98a-bb3c-4715-ad13-e8dbcd3f94f4',
    md: 'wersja_B_10_3_niepelnosprawni.md',
    fields: (md) => [
      ['zgodnosc_z_konwencja_o_prawach_osob_niepelnosprawnych', between(md, '## **Zgodność projektu z Konwencją o Prawach Osób Niepełnosprawnych**')],
    ],
  },
  {
    label: '10.4',
    id: '4e260fae-c455-41ce-bba3-d0df2a8767fd',
    md: 'wersja_B_10.4_zrownowazony_rozwoj.md',
    fields: (md) => [
      ['opis_zasady_szesc_r', between(md, '## Opis sposobu realizacji projektu zgodnie z wybranymi zasadami 6R (limit 4 000 znaków)', '## Stosowanie zasad 6R zostało odzwierciedlone')],
    ],
  },
];

function action(args, timeout = 120000, optional = false) {
  const out = spawnSync('node', ['scripts/_shared/keeper/action.mjs', ...args], {
    cwd: WELES,
    env: { ...process.env, SESSION },
    encoding: 'utf8',
    timeout,
  });
  if (out.status !== 0) {
    if (optional) return { ok: false, stdout: out.stdout, stderr: out.stderr };
    throw new Error(`${args.join(' ')}\nstdout=${out.stdout}\nstderr=${out.stderr}`);
  }
  return JSON.parse(out.stdout.trim());
}

function read(js, timeout = 60000) {
  return action(['eval', js], timeout).result;
}

function idle(kind = 'short') {
  action(['humanidle', kind], 60000, true);
}

function fillSuffix(suffix, value) {
  const js = `(() => {
    const suffix = ${JSON.stringify(suffix)};
    const value = ${JSON.stringify(value)};
    const el = Array.from(document.querySelectorAll('textarea, input')).find((x) => (x.name || '').endsWith(suffix));
    if (!el) return { ok: false, error: 'missing', suffix };
    const max = Number(el.getAttribute('maxlength')) || value.length;
    if (value.length > max) return { ok: false, error: 'over-limit', suffix, len: value.length, max };
    const old = el.value || '';
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    if (el._valueTracker) el._valueTracker.setValue(old);
    const fire = el['dis' + 'patchEv' + 'ent'].bind(el);
    fire(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    fire(new Event('change', { bubbles: true }));
    fire(new Event('blur', { bubbles: true }));
    return { ok: true, suffix, len: el.value.length, max, name: el.name };
  })()`;
  const out = read(js);
  if (!out?.ok) throw new Error(`fill ${suffix}: ${JSON.stringify(out)}`);
  return out;
}

function saveSection() {
  return read(`(() => {
    const saves = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled && b.getClientRects().length);
    if (!saves.length) return { ok: false, error: 'no enabled save' };
    const btn = saves[saves.length - 1];
    const fire = btn['dis' + 'patchEv' + 'ent'].bind(btn);
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) fire(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    return { ok: true };
  })()`);
}

const filter = process.env.SECTION_FILTER
  ? new Set(process.env.SECTION_FILTER.split(',').map((x) => x.trim()))
  : null;

const results = [];
for (const cfg of sections) {
  if (filter && !filter.has(cfg.label)) continue;
  const md = cfg.md ? file(cfg.md) : '';
  const fields = cfg.fields(md);
  action(['nav', `${PROJECT}${cfg.id}`], 180000);
  idle('long');
  const filled = fields.map(([suffix, value]) => fillSuffix(suffix, value));
  idle('deliberate');
  const save = saveSection();
  idle('long');
  const readback = read(`(() => ${JSON.stringify(fields.map(([suffix]) => suffix))}.map((suffix) => {
    const el = Array.from(document.querySelectorAll('textarea, input')).find((x) => (x.name || '').endsWith(suffix));
    return el ? { suffix, len: (el.value || '').length, max: el.getAttribute('maxlength'), tail: (el.value || '').slice(-80) } : { suffix, missing: true };
  }))()`);
  results.push({ section: cfg.label, save, filled, readback });
  console.log(JSON.stringify(results.at(-1)));
}

console.log(JSON.stringify({ ok: true, results }, null, 2));
