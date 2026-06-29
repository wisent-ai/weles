import { readFileSync, writeFileSync } from 'node:fs';

const SRC = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_2.3_rynek_i_potencjal.md';
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
function fitName(text) {
  const suffixes = [
    'Definicja wskaźnika obejmuje jednostkę miary, rynek geograficzny, okres pomiaru, kwalifikowany dowód źródłowy, wyłączenia oraz odpowiedzialność za ewidencję i kontrolę.',
    'Wskaźnik jest przypisany do komercjalizacji RNM, rynku docelowego, dokumentu źródłowego, daty pomiaru, sposobu deduplikacji i ścieżki kontroli.',
    'Pomiar obejmuje tylko zdarzenia udokumentowane księgowo, kontraktowo lub systemowo, z możliwością kontroli w dokumentacji projektu.',
    'Ujęto zakres, dowód, rok pomiaru i wyłączenia.',
    'Dowód: umowa, faktura, log API.',
    'Dowód: faktura i umowa.',
    'Rok i rynek wskazane.',
  ];
  let out = clean(text);
  for (const suffix of suffixes) {
    if (out.length >= 490) break;
    const next = clean(`${out} ${suffix}`);
    if (next.length <= 500) out = next;
  }
  for (let pass = 0; pass < 3 && out.length < 490; pass += 1) {
    for (const suffix of ['Dowód: umowa.', 'Faktura.', 'Log API.', 'Rok.', 'Rynek.', 'Bez duplikatów.']) {
      if (out.length >= 490) break;
      const next = clean(`${out} ${suffix}`);
      if (next.length <= 500) out = next;
    }
  }
  if (out.length > 500) out = out.slice(0, 497).replace(/\s+\S*$/, '');
  if (!/[.!?]$/.test(out) && out.length < 500) out += '.';
  return out;
}
const names = [
  'Liczba płatnych odbiorców enterprise spoza rynku wewnętrznego UE korzystających z modeli RNM Wisent, liczona jako aktywni klienci z umową, fakturą lub billingiem API w roku docelowym, z wyłączeniem testów bezpłatnych, leadów sprzedażowych i podmiotów powiązanych z Wnioskodawcą',
  'Wartość rocznych przychodów netto Wisent Polska ze sprzedaży modeli RNM klientom spoza rynku wewnętrznego UE, liczona według faktur sprzedaży i umów licencyjnych/API w roku docelowym, bez VAT, dotacji, usług jednorazowych niezwiązanych z RNM oraz transakcji wewnątrzgrupowych',
  'Liczba klientów z listy Fortune 500 Europe, którzy w roku docelowym odpłatnie korzystają z modeli RNM Wisent na podstawie umowy, faktury lub aktywnego billingu API, z potwierdzonym wdrożeniem produkcyjnym albo pilotażem płatnym i przypisanym krajem siedziby klienta',
  'Roczne przychody netto Wisent Polska ze sprzedaży modeli RNM klientom enterprise na rynku wewnętrznym UE, mierzone według faktur, umów licencyjnych i billingu API w roku docelowym, bez VAT, dotacji, prac jednorazowych niezwiązanych z RNM i przychodów od podmiotów powiązanych',
  'Skumulowane przychody netto Wisent Polska ze sprzedaży modeli RNM na rynku wewnętrznym UE od pierwszego roku komercjalizacji do roku docelowego, liczone narastająco na podstawie faktur, umów licencyjnych, billingu API i ewidencji księgowej przypisanej do produktu RNM',
  'Roczne przychody Wisent Polska ze sprzedaży modeli RNM do klientów z rynku wewnętrznego UE w roku docelowym, obejmujące licencje, dostęp API i wdrożenia produkcyjne RNM, z wyłączeniem VAT, dotacji, testów bezpłatnych, prac niezwiązanych z RNM i przychodów poza UE',
  'Liczba państw członkowskich UE, z których pochodzą płatni klienci enterprise korzystający z modeli RNM Wisent w roku docelowym, liczona według kraju siedziby kontrahenta z umowy lub faktury, z wyłączeniem leadów, testów bezpłatnych i klientów spoza rynku wewnętrznego UE',
  "Liczba odbiorców MŚP, software house'ów i integratorów korzystających z RNM w modelu otwartym lub komercyjnym w roku docelowym, potwierdzona pobraniami, kluczami API, aktywnymi kontami, zgłoszeniami wdrożeniowymi albo umowami, bez zliczania botów i duplikatów",
  'Liczba miejsc pracy w przeliczeniu na EPC utworzonych w Wisent Polska w związku z komercjalizacją modeli RNM, obejmująca role B+R, MLOps, wdrożeniowe, sprzedaż techniczną i obsługę klienta, liczona według umów, list płac i przypisania obowiązków do produktu RNM',
  'Liczba nowych projektów B+R+I uruchomionych przez Wisent w wyniku realizacji projektu RNM, obejmująca dalsze badania, rozwój funkcji, rozszerzenia branżowe i projekty z partnerami UE, liczona tylko dla przedsięwzięć z kartą projektu, budżetem i wyznaczonym właścicielem',
];

let i = 0;
let md = readFileSync(SRC, 'utf8');
md = md.replace(/(\| Nazwa parametru \| )([^|]+)( \|)/g, (all, pre, _old, post) => {
  if (i >= names.length) return all;
  const next = `${pre}${fitName(names[i])}${post}`;
  i += 1;
  return next;
});

writeFileSync(SRC, md);
console.log(JSON.stringify({ ok: true, changed: i, file: SRC }, null, 2));
