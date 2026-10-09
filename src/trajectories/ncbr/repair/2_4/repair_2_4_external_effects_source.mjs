import { readFileSync, writeFileSync } from 'node:fs';

const SRC = (await import('#ncbr-settings')).applicationFile(
  'wersja_B_2.4_efekty_zewnetrzne.md',
);
let md = readFileSync(SRC, 'utf8');
const clean = (s) =>
  String(s || '')
    .replace(/\s+/g, ' ')
    .trim();


const rows = [
  {
    old: 'Skumulowana liczba unikniętych pełnych cykli dotrenowywania modeli u odbiorców w UE dzięki adaptacji przez edycję reprezentacji',
    name: 'Skumulowana liczba pełnych cykli dotrenowywania modeli AI unikniętych u odbiorców z rynku wewnętrznego UE dzięki adaptacji RNM przez edycję kierunków reprezentacji zamiast ponownego treningu, liczona na podstawie rejestru wdrożeń, z wyłączeniem testów bezpłatnych i duplikatów odbiorców',
    base: '0 (unikniętych cykli)',
    baseYear: '2026',
    target: 'co najmniej 50 (unikniętych cykli)',
    targetYear: '2033',
    method:
      'Wartość docelową szacujemy oddolnie, od liczby odbiorców na rynku wewnętrznym UE. Z modelu finansowego projektu wynika rampa odbiorców enterprise: 6 na koniec 2030 r., 16 w 2031 r., 32 w 2032 r. i 50 w 2033 r. Każdy odbiorca, zamiast przeprowadzać co najmniej jeden pełny cykl dotrenowywania modelu do zastosowania sektorowego, korzysta z adaptacji modelu RNM przez edycję kierunków konceptów, która nie wymaga ponownego treningu. Przyjmujemy ostrożnie jeden uniknięty cykl na jednego odbiorcę, co przy 50 odbiorcach daje co najmniej 50 unikniętych cykli.',
    verify:
      'Monitorowanie będzie oparte na rejestrze wdrożeń modeli RNM u odbiorców zewnętrznych oraz raportach z adaptacji modeli przez edycję reprezentacji. Dla każdego odbiorcy zapisujemy kraj, sektor, wersję modelu, zakres adaptacji, datę wdrożenia, dowód użycia edycji reprezentacji oraz informację, czy alternatywą byłby pełny cykl dotrenowywania modelu. Weryfikacja kwartalna obejmuje logi pipeline, protokoły wdrożeń i ankiety techniczne u odbiorców.',
  },
  {
    old: 'Udział odpowiedzi modelu produkcyjnego RNM opatrzonych konstrukcyjnym raportem audytowym wskazującym aktywne koncepty',
    name: 'Udział odpowiedzi produkcyjnego modelu RNM, dla których system automatycznie generuje konstrukcyjny raport audytowy aktywnych konceptów, wersji katalogu, siły aktywacji i powiązania z tokenami odpowiedzi, liczony na reprezentatywnych logach inferencyjnych w sektorach regulowanych UE',
    base: '0% (model odniesienia nie dostarcza konstrukcyjnego raportu)',
    baseYear: '2026',
    target: '100%',
    targetYear: '2030',
    method:
      'Wartość docelowa wynika z konstrukcji RNM. Koncepty istotne dla kontroli i bezpieczeństwa są kodowane jako stabilne, adresowalne kierunki w przestrzeni aktywacji, dlatego każda odpowiedź modelu może otrzymać raport wskazujący aktywne kierunki i ich wpływ na generację. Model odniesienia oparty na klasycznej architekturze nie dostarcza takiej konstrukcyjnej informacji, stąd wartość bazowa wynosi 0%. Wartość docelową ustalamy na 100%, ponieważ raport jest generowany jako element inferencji, a nie opcjonalny komponent.',
    verify:
      'Weryfikacja polega na audycie logów inferencyjnych modelu RNM w środowisku testowym i produkcyjnym. Dla reprezentatywnego zbioru zapytań rejestrujemy odpowiedź modelu wraz z raportem audytowym i liczymy odsetek odpowiedzi, dla których raport aktywnych kierunków konceptów został wygenerowany i jest kompletny. Sprawdzamy obecność identyfikatorów konceptów, siły aktywacji, wersji katalogu, wersji modelu oraz powiązania raportu z zapytaniem i odpowiedzią.',
  },
  {
    old: 'Liczba urzędowych języków UE obsługiwanych przez RNM powyżej progu jakości generacji',
    name: 'Liczba urzędowych języków Unii Europejskiej, w których model RNM osiąga wynik generacji powyżej ustalonego progu jakości na publicznym benchmarku wielojęzycznym, liczona osobno dla każdego języka i wersji modelu, z zachowaniem raportu porównania do modelu odniesienia',
    base: '0',
    baseYear: '2026',
    target: '24 (wszystkie języki urzędowe UE)',
    targetYear: '2033',
    method:
      'Wartość docelową ustalamy na 24, co odpowiada wszystkim językom urzędowym UE. Wartość bazowa to liczba języków, które model odniesienia obsługuje powyżej ustalonego progu jakości generacji; mierzymy ją na początku projektu na tym samym benchmarku. RNM zakłada, że kompetencje językowe są kodowane jako adresowalne kierunki reprezentacji, które można wzmacniać bez pełnego dotrenowywania i bez utraty jakości w pozostałych językach. Próg jakości definiujemy względem modelu odniesienia na publicznym benchmarku wielojęzycznym.',
    verify:
      'Osiągnięcie wartości docelowej weryfikujemy poprzez coroczne uruchomienie publicznego benchmarku wielojęzycznego na wszystkich 24 językach urzędowych UE. Dla każdego języka porównujemy wynik modelu RNM z progiem jakości zdefiniowanym na bazie modelu odniesienia. Wyniki zapisujemy z wersją modelu, wersją benchmarku, datą uruchomienia, konfiguracją inferencji, osobą odpowiedzialną i pełnym raportem per język. Liczbę języków spełniających próg dokumentujemy w raportach okresowych i końcowym.',
  },
  {
    old: 'Liczba wdrożeń RNM w sektorach regulowanych UE korzystających z raportu audytowego aktywnych konceptów',
    name: 'Liczba wdrożeń modeli RNM u odbiorców z sektorów regulowanych rynku wewnętrznego UE, w których raport aktywnych konceptów jest używany w procesie audytu, nadzoru, dokumentowania zgodności albo kontroli ryzyka AI, potwierdzona umową, protokołem odbioru i próbką raportu',
    base: '0 wdrożeń',
    baseYear: '2026',
    target: 'co najmniej 3 wdrożenia',
    targetYear: '2033',
    method:
      'Wartość docelowa wynika z planu komercjalizacji w sektorach, w których audytowalność AI ma szczególne znaczenie społeczne i regulacyjne: finanse, ochrona zdrowia oraz cyberbezpieczeństwo. Przyjmujemy konserwatywnie po jednym wdrożeniu w każdym z tych sektorów. Wdrożenie liczy się tylko wtedy, gdy odbiorca z rynku wewnętrznego UE używa modelu RNM lub komponentu kontroli reprezentacyjnej oraz otrzymuje raport aktywnych konceptów jako część działania systemu. Parametr mierzy efekt zewnętrzny w postaci łatwiejszego nadzoru i kontroli zgodności.',
    verify:
      'Weryfikacja będzie prowadzona na podstawie umów wdrożeniowych, protokołów odbioru, dokumentacji technicznej wdrożenia oraz próbek raportów audytowych wygenerowanych przez system RNM. Dla każdego wdrożenia rejestrujemy sektor, kraj siedziby odbiorcy, zakres użycia modelu, wersję katalogu konceptów, datę uruchomienia, rolę raportu w procesie audytu oraz potwierdzenie, że raport aktywnych konceptów jest generowany i archiwizowany jako dowód zgodności.',
  },
  {
    old: 'Udział głównych cykli treningowych RNM objętych pomiarem energii, CO2eq i kryteriami zielonych zamówień',
    name: 'Udział głównych cykli treningowych i ewaluacyjnych RNM objętych pełnym pomiarem zużycia energii, czasu pracy GPU, lokalizacji infrastruktury, szacunku CO2eq, danych PUE/OZE dostawcy oraz kryteriami zielonych zamówień, liczony w rejestrze eksperymentów projektu',
    base: '0% cykli',
    baseYear: '2026',
    target: '100% głównych cykli treningowych i ewaluacyjnych',
    targetYear: '2029',
    method:
      'Parametr wynika z zaplanowanego systemu MLOps i rejestru eksperymentów. Każdy główny cykl treningowy i ewaluacyjny RNM ma mieć wpis obejmujący identyfikator eksperymentu, typ akceleratora, czas pracy GPU, lokalizację infrastruktury, źródło danych o PUE/OZE dostawcy, szacowane kWh oraz CO2eq. Wartość docelowa 100% jest realna, ponieważ pomiar jest częścią procesu uruchomienia eksperymentu, a nie osobnym działaniem środowiskowym po zakończeniu prac. Parametr pokazuje klimatyczny efekt zewnętrzny projektu.',
    verify:
      'Monitorowanie będzie prowadzone przez rejestr eksperymentów, logi klastra, dane billingowe dostawcy GPU, metadane infrastruktury i okresowy raport środowiskowy. Dla każdego kwartału liczymy liczbę głównych cykli treningowych i ewaluacyjnych oraz liczbę cykli z kompletnymi polami energii, CO2eq i kryteriów zakupu. Weryfikacja obejmuje identyfikator eksperymentu, datę, wersję modelu, dostawcę infrastruktury, szacowanie emisji, podstawę danych i akceptację osoby odpowiedzialnej.',
  },
];

function rowBlock(row, index) {
  return `### Parametr ${index + 1}

| Pole | Wartość |
|---|---|
| Nazwa parametru | ${clean(row.name)} |
| Wartość bazowa (z jednostką miary) | ${row.base} |
| Rok bazowy | ${row.baseYear} |
| Wartość docelowa (z jednostką miary) | ${row.target} |
| Rok docelowy | ${row.targetYear} |
| Metoda oszacowania wartości docelowej | ${clean(row.method)} |
| Sposób monitorowania/weryfikacji osiągnięcia zaplanowanych wartości docelowych | ${clean(row.verify)} |`;
}

const title = '## Parametry opisujące dodatkowe efekty zewnętrzne innowacji';
const start = md.indexOf(title);
if (start < 0) throw new Error('parameter title not found');
const before = md.slice(0, start + title.length);
md = `${before}\n\n${rows.map(rowBlock).join('\n\n')}\n\n---\n`;
writeFileSync(SRC, md);

console.log(
  JSON.stringify({ ok: true, file: SRC, rows: rows.length }, null, 2),
);
