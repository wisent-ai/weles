import { readFileSync, writeFileSync } from 'node:fs';

const SRC = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_2.2_innowacyjnosc_i_zaleznosci.md';
const md = readFileSync(SRC, 'utf8');

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const METHOD_EXTENSION = clean(`Dodatkowo oszacowanie zostanie powiązane z harmonogramem zadań, budżetem obliczeniowym, konkretnymi artefaktami B+R oraz dokumentami odbioru. Nie zaliczamy deklaracji, materiałów sprzedażowych ani jednorazowych testów bez odtwarzalnej konfiguracji. Każdy wynik musi mieć źródło danych, datę pomiaru, właściciela odpowiedzialnego za pomiar i ścieżkę dowodową umożliwiającą ponowne przeliczenie wartości w kontroli projektu.`);
const VERIFY_EXTENSION = clean(`Kontrola będzie prowadzona w cyklu kwartalnym i końcowym. Dla każdego dowodu zostanie wskazana wersja artefaktu, data, osoba odpowiedzialna, źródło danych i miejsce przechowywania. Weryfikacja nie będzie oparta na samej deklaracji zespołu; wymagany jest dokument projektowy, log techniczny, raport, faktura, umowa, protokół odbioru albo inny trwały dowód możliwy do okazania instytucji oceniającej.`);

function fit(text, max, target = max - 3) {
  let out = clean(text);
  if (out.length < target) out = clean(`${out} ${max === 1000 ? METHOD_EXTENSION : VERIFY_EXTENSION}`);
  if (out.length < target) out = clean(`${out} Dodatkowo opis obejmuje zakres danych, częstotliwość pomiaru, kryterium zaliczenia oraz sposób rozdzielenia wyniku projektu od działań rutynowych i komercyjnych.`);
  if (out.length <= max) return out;
  out = out.slice(0, target).replace(/\s+\S*$/, '').replace(/[;,:-]\s*$/, '');
  if (!/[.!?]$/.test(out)) out += '.';
  if (out.length > max) throw new Error(`fit failed ${out.length}/${max}`);
  return out;
}

const rows = [
  {
    factor: 'Przyczynia się do wiodącej pozycji Unii w dziedzinie przemysłu i technologii',
    param: 'Jakość generatywna modelu RNM 70B względem modelu referencyjnego na benchmarku MMLU',
    base: '0% (brak modelu RNM)',
    target: '≥95% wyniku Llama 3.1 70B przy ≤10 bln tokenów treningowych',
    baseYear: '2026',
    targetYear: '2029',
    method: fit(`Parametr jest szacowany przez kontrolowane porównanie krzywych uczenia modelu RNM 70B i modelu referencyjnego Llama 3.1 70B przy identycznej klasie sprzętu, tej samej precyzji obliczeń, porównywalnym budżecie tokenów oraz jawnie opisanej konfiguracji optymalizatora, danych i procedur bezpieczeństwa. Wartość docelowa oznacza, że model RNM osiąga co najmniej 95% wyniku referencyjnego na MMLU przy zużyciu nie większym niż 10 bln tokenów treningowych, czyli nie jest tylko demonstratorem koncepcji, ale pełnowartościowym europejskim modelem bazowym. Pomiar będzie powtarzany co 500 mld tokenów oraz po zakończeniu treningu, a wynik końcowy zostanie zestawiony z jakością, kosztem treningu, stabilnością reprezentacji i zachowaniem kompetencji po interwencjach. Takie oszacowanie odpowiada zarzutowi, że projekt nie może opierać się wyłącznie na ogólnej idei architektury: mierzymy konkretny rezultat technologiczny względem istniejącego modelu rynkowego i określonego budżetu obliczeniowego.`, 1000),
    verify: fit(`Weryfikacja obejmie raporty z przebiegu treningu, logi eksperymentów, konfiguracje danych i optymalizatora, wyniki MMLU dla kolejnych checkpointów, końcowy raport porównawczy z modelem referencyjnym oraz manifest modelu RNM. Dane będą przechowywane w repozytorium projektu wraz z wersjami kodu i kartą modelu. Osiągnięcie wartości docelowej potwierdza wynik testu końcowego, powtarzalność uruchomienia ewaluacji i podpisany protokół odbioru zadania B+R.`, 800),
  },
  {
    factor: 'Stanowi wkład w infrastrukturę krytyczną na szczeblu europejskim',
    param: 'Liczba wdrożeń RNM w sektorach regulowanych lub krytycznych rynku UE',
    base: '0 wdrożeń',
    target: '3 wdrożenia pilotażowe lub komercyjne',
    baseYear: '2026',
    targetYear: '2033',
    method: fit(`Parametr jest szacowany na podstawie planu wdrożenia RNM w sektorach, w których model bazowy AI staje się elementem infrastruktury cyfrowej: finansach, ochronie zdrowia, cyberbezpieczeństwie, administracji lub przemyśle. Za wdrożenie uznaje się wyłącznie przypadek, w którym podmiot z UE używa modelu RNM albo komponentu kontroli reprezentacyjnej w środowisku pilotażowym lub produkcyjnym, z udokumentowanym celem biznesowym, technicznym zakresem integracji i odpowiedzialnością za dane. Wartość trzech wdrożeń jest konserwatywna wobec modelu sprzedaży: nie liczymy zapytań testowych, materiałów marketingowych ani samego pobrania modelu. Każde wdrożenie ma pokazać, że RNM jest produktem nadającym się do użycia w regulowanym otoczeniu UE, a nie tylko publikacją badawczą.`, 1000),
    verify: fit(`Monitorowanie będzie prowadzone przez rejestr wdrożeń, umowy pilotażowe lub komercyjne, protokoły odbioru, dokumentację architektury integracji, karty ryzyka, logi dostępu do modelu oraz raporty okresowe projektu. Weryfikacja wymaga wskazania kraju siedziby klienta, sektora zastosowania, zakresu wykorzystanej funkcji RNM i daty uruchomienia. Wdrożenie zostanie zaliczone dopiero po potwierdzeniu przez klienta lub partnera technicznego.`, 800),
  },
  {
    factor: 'Wpływa na zwiększenie bezpieczeństwa dostaw',
    param: 'Wartość importu usług modeli generatywnych spoza UE zastąpionych przez wdrożenia RNM wśród klientów projektu, liczona jako roczna wartość przychodów z europejskich wdrożeń RNM, które ograniczają zakup zamkniętych API, hostingu, dostrajania lub licencji modeli bazowych kontrolowanych przez dostawców z państw trzecich i przenoszą tę zdolność do europejskiego łańcucha wartości AI wraz z krajem siedziby klienta, typem zastąpionej usługi, dowodem przeniesienia wydatku do UE i audytem rocznym',
    base: '0 PLN',
    target: '24 000 000 PLN',
    baseYear: '2026',
    targetYear: '2033',
    method: fit(`Parametr szacuje wartość usług generatywnej AI, które klienci z rynku wewnętrznego UE mogą kupić od europejskiego dostawcy RNM zamiast od dostawców spoza UE. Punktem wyjścia jest docelowy model przychodowy po zakończeniu projektu oraz założenie, że 80% przychodów z klientów UE innych niż Polska zastępuje wydatki na importowane modele API, dostrajanie lub hosting modeli bazowych. Nie traktujemy tego jako abstrakcyjnej korzyści makroekonomicznej: każda kwota musi wynikać z faktury, umowy licencyjnej, wdrożeniowej albo dostępu API. Metoda odpowiada na kryterium bezpieczeństwa dostaw, bo mierzy realne przesunięcie zakupów z zależnych usług spoza UE na rozwiązanie rozwijane, utrzymywane i audytowane w UE.`, 1000),
    verify: fit(`Weryfikacja będzie oparta na księgach rachunkowych Wisent Polska, fakturach sprzedaży, umowach licencyjnych i wdrożeniowych, ewidencji kraju siedziby klienta, rejestrze użycia API lub lokalnych wdrożeń oraz rocznych zestawieniach przychodów. Dla każdego klienta zostanie wskazane, czy wdrożenie zastępuje dotychczasowe usługi spoza UE lub ogranicza potrzebę ich zakupu. Wartość docelowa będzie potwierdzana narastająco po zakończeniu projektu.`, 800),
  },
  {
    factor: 'Wpływa na zwiększenie zdolności produkcyjnych',
    param: 'Liczba skal modeli RNM wytrenowanych i udostępnionych jako europejskie artefakty bazowe',
    base: '0 skal modeli RNM',
    target: '4 skale modeli: 1B, 8B, 30B i 70B',
    baseYear: '2026',
    targetYear: '2029',
    method: fit(`Parametr mierzy zdolność wytwarzania modeli bazowych RNM w UE, a nie samą liczbę eksperymentów. Za skalę modelu uznajemy kompletny artefakt obejmujący checkpoint, konfigurację treningu, kartę modelu, raport jakości, raport stabilności reprezentacji i procedurę uruchomienia. Sekwencja 1B, 8B, 30B i 70B odzwierciedla ścieżkę B+R: małe modele służą do testowania funkcji celu i separacji konceptów, model średni do walidacji skalowania, a 70B do porównania z referencją rynkową. Wartość docelowa pokazuje zwiększenie zdolności produkcyjnych, bo po projekcie Wisent ma posiadać powtarzalny europejski pipeline projektowania, treningu, ewaluacji i publikacji modeli, zamiast jednorazowego prototypu zależnego od cudzej architektury.`, 1000),
    verify: fit(`Weryfikacja obejmie repozytoria modeli i kodu, manifesty treningu, karty modeli, raporty ewaluacji, wersjonowane konfiguracje, checksumy artefaktów, lokalizację infrastruktury obliczeniowej w UE oraz protokoły odbioru zadań B+R. Każda skala zostanie zaliczona po udokumentowaniu kompletności artefaktu i możliwości powtórzenia procedury ewaluacyjnej. Raport końcowy zestawi cztery skale z planem harmonogramu i budżetem obliczeniowym.`, 800),
  },
  {
    factor: 'Skutkuje promowaniem pozytywnych skutków transgranicznych na rynku wewnętrznym',
    param: 'Liczba państw rynku wewnętrznego UE, z których pochodzą płatni klienci korzystający z modeli RNM',
    base: '0 państw',
    target: '6 państw',
    baseYear: '2026',
    targetYear: '2033',
    method: fit(`Parametr jest szacowany na podstawie planu komercjalizacji RNM na rynku wewnętrznym UE, obejmującego przedsiębiorstwa i instytucje z sektorów regulowanych w kilku państwach członkowskich. Państwo zostanie zaliczone tylko wtedy, gdy płatny klient ma siedzibę w danym kraju i korzysta z modelu RNM, biblioteki kontroli reprezentacyjnej, lokalnego wdrożenia albo dostępu API. Wartość sześciu państw wynika z modelu target-account dla dużych organizacji europejskich oraz z charakteru produktu: audytowalna AI ma zastosowanie transgraniczne, ponieważ ten sam model może być hostowany lokalnie, dostosowany do języków UE i używany zgodnie z AI Act. Parametr nie liczy pobrań open-source ani zapytań sprzedażowych, tylko faktyczne płatne użycie.`, 1000),
    verify: fit(`Monitorowanie obejmie rejestr klientów z krajem siedziby, numery VAT UE lub dane rejestrowe, faktury, umowy, datę rozpoczęcia korzystania z RNM, typ użytego produktu oraz raporty okresowe sprzedaży. Weryfikacja zostanie wykonana przez zestawienie klientów według państwa i wykluczenie duplikatów w obrębie grup kapitałowych, jeżeli nie reprezentują odrębnego użycia produktu. Wynik będzie potwierdzony w sprawozdaniu końcowym i dokumentacji komercjalizacji.`, 800),
  },
];

const header = '| Wybrany czynnik | Parametr | Wartość bazowa | Wartość docelowa | Rok bazowy | Rok docelowy | Metoda oszacowania wartości docelowej | Sposób monitorowania/weryfikacji |';
const sep = '|---|---|---|---|---|---|---|---|';
const table = [header, sep, ...rows.map((r) => `| ${r.factor} | ${r.param} | ${r.base} | ${r.target} | ${r.baseYear} | ${r.targetYear} | ${r.method} | ${r.verify} |`)].join('\n');

const startMarker = '## Podsumowanie wpływu prac B+R na ograniczanie lub zwalczanie zależności Unii\n\n';
const endMarker = '\n\n## Powiązanie rezultatu prac B+R z łańcuchem wartości konkretnej technologii krytycznej';
const start = md.indexOf(startMarker);
const end = md.indexOf(endMarker, start);
if (start < 0 || end < 0) throw new Error('table markers not found');

const next = md.slice(0, start + startMarker.length) + table + md.slice(end);
writeFileSync(SRC, next);
console.log(JSON.stringify({
  ok: true,
  file: SRC,
  rows: rows.length,
  lengths: rows.map((r) => ({
    factor: r.factor.slice(0, 40),
    method: r.method.length,
    verify: r.verify.length,
  })),
}, null, 2));
