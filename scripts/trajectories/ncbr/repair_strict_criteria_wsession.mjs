// Strict STEP B criteria repair for the replacement NCBR draft.
// UI-only Weles WSession. Never submits or withdraws the application.

import { WSession } from '../../../dist/index.js';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const PROJECT_ID = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const PROJECT_URL = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}`;
const BASE = `${PROJECT_URL}/projekt_step/`;
const URLS = {
  '1.2': `${BASE}0ca77e3d-373e-464f-9e9d-a35f5193864d`,
  '2.2': `${BASE}80ebca16-a9dd-4798-a334-5ac007cecbf7`,
  '2.3': `${BASE}c5dbdc83-5baf-4866-b3d8-4da3ae553865`,
  '3.2': `${BASE}06a70163-2dcc-47a0-b64b-201656946538`,
  '6.1': `${BASE}566c735c-8ad0-406f-a948-f3ea921c2cc7`,
  '9.2': `${BASE}e95d0c23-8a39-4d56-96fa-ace3e4f0d23a`,
};
const email = process.env.NCBR_EMAIL;
const password = process.env.NCBR_PASSWORD;

if (!email || !password) {
  console.log(JSON.stringify({ error: 'MISSING_NCBR_CREDENTIALS' }, null, 2));
  process.exit(2);
}
delete process.env.NCBR_PASSWORD;

const scalarRepairs = [
  {
    section: '1.2',
    suffix: 'produkt_koncowy_technologii_krytycznej',
    value: 'Rodzina modeli generatywnych RNM 1B-70B tworzona w UE jako produkt końcowy technologii krytycznej AI. Produkt obejmuje wagi modeli, architekturę treningu reprezentacyjnego, katalog kierunków konceptów, bibliotekę interwencji i mechanizm śladu audytowego. W odróżnieniu od klasycznych transformerów RNM projektują stabilne reprezentacje już w treningu, co umożliwia kontrolę i audyt zachowania modelu bez pełnego ponownego trenowania.',
  },
  {
    section: '2.2',
    suffix: 'innowacja_produktowa_opis_rezultatu_prac_br',
    value: [
      'Rezultatem prac B+R będzie Wisent RNM Platform: rodzina modeli natywnie reprezentacyjnych 1B, 8B, 30B i 70B, katalog kierunków konceptów, biblioteka interwencji oraz procedury ewaluacji i audytu. Produkt nie jest aplikacją opartą na istniejącym modelu ani integracją cudzych usług AI. Jest nową warstwą modelową, w której geometria reprezentacji wewnętrznych jest kształtowana w czasie treningu jako część architektury modelu.',
      'Istniejące metody representation engineering, activation steering, RLHF, DPO, LoRA, filtry treści i prompt engineering działają głównie po treningu albo na wejściu lub wyjściu modelu. Nie tworzą modelu, w którym koncepty bezpieczeństwa, prawdziwości, odmowy treści szkodliwych i zgodności regulacyjnej są od początku uczone jako stabilne, mierzalne i lokalnie edytowalne struktury aktywacji. Nowość RNM polega właśnie na przejściu od sterowania post-hoc do architektury, w której reprezentacje są projektowanym obiektem treningu.',
      'Cechy rezultatu wynikające bezpośrednio z prac B+R to: stabilność kierunków konceptów między checkpointami, separowalność i lokalność interwencji, możliwość ograniczania halucynacji przez edycję reprezentacji, zachowanie kompetencji pobocznych po interwencji, rejestrowany ślad audytowy oraz niższy koszt adaptacji niż pełny ponowny trening modelu. Każda cecha ma mierzalny parametr: podobieństwo kosinusowe kierunków, liczba naruszonych kompetencji pobocznych, zmiana jakości na benchmarkach, liczba konceptów w katalogu, kompletność logów audytowych i redukcja tokenów lub energii względem modelu referencyjnego.',
      'Produktem po zakończeniu projektu będą artefakty możliwe do wdrożenia poza projektem: wersjonowane wagi RNM, biblioteka wisent-rnm, katalog konceptów, skrypty ewaluacyjne, karty modeli i dokumentacja techniczna. Komercjalizacja, sprzedaż, utrzymanie produkcyjne i obsługa klientów nie są przedmiotem finansowanych prac B+R; są planowane po zakończeniu projektu jako wdrożenie wyników w działalności Wisent Polska i przez licencjobiorców w UE.',
      'Rezultat odpowiada na potrzeby sektorów regulowanych UE, które wymagają większej kontroli nad modelami ogólnego przeznaczenia niż oferują zamknięte modele spoza UE. RNM dostarczają mechanizm audytu i interwencji na poziomie reprezentacji, a nie wyłącznie opisową dokumentację działania modelu. Dzięki temu produkt wspiera wymogi AI Act dotyczące zarządzania ryzykiem, rejestrowania zdarzeń, nadzoru ludzkiego i przejrzystości, przy zachowaniu niezależności technologicznej rynku UE.',
    ].join('\n\n'),
  },
  {
    section: '2.2',
    suffix: 'innowacja_produktowa_wplyw_rezultatu_prac_br',
    value: [
      'Rezultat ogranicza strategiczną zależność UE, ponieważ przenosi kluczową warstwę tworzenia i kontroli modeli generatywnych do technologii rozwijanej, utrzymywanej i wdrażanej przez podmiot z UE. Obecna zależność nie polega tylko na zakupie dostępu do gotowego oprogramowania. Dotyczy braku europejskiej zdolności projektowania bazowej architektury modeli, audytu ich zachowania, lokalnego dostosowania do regulacji i utrzymania ciągłości dostępu bez ryzyka zmiany polityki dostawcy spoza UE.',
      'Projekt spełnia co najmniej trzy czynniki STEP dla Ścieżki B. Po pierwsze, wzmacnia wiodącą pozycję UE w technologii AI przez rozwój architektury modelowej, a nie aplikacji końcowej. Po drugie, zwiększa bezpieczeństwo dostaw kluczowej technologii cyfrowej, ponieważ wagi, kod, katalog konceptów i procedury ewaluacyjne są tworzone w UE i mogą być wdrażane bez zależności od zamkniętego API. Po trzecie, tworzy pozytywne skutki transgraniczne: produkt może być używany przez podmioty z różnych państw UE w sektorach regulowanych wymagających audytu i zgodności z AI Act.',
      'Przewaga względem istniejących rozwiązań polega na mierzalnej kontroli przyczynowej w przestrzeni aktywacji. Modele transformerowe i metody dostrajania potrafią poprawiać zachowanie statystycznie, ale nie zapewniają stabilnego katalogu reprezentacji powiązanych z konkretnymi funkcjami bezpieczeństwa i kompetencjami. RNM mają wykazać, że można trenować modele, w których wybrane zachowania są adresowalne, modyfikowalne i weryfikowalne bez pełnego ponownego treningu.',
      'Wpływ gospodarczy jest związany z możliwością budowy europejskich usług AI dla finansów, zdrowia, cyberbezpieczeństwa, przemysłu i administracji. Produkt obniża koszt adaptacji modeli do wymogów sektorowych, skraca drogę do zgodności regulacyjnej i zmniejsza zależność od zagranicznych dostawców modeli frontier. Dowodami osiągnięcia wpływu będą wdrożenie produktu RNM, licencje lub umowy z podmiotami UE, dokumentacja techniczna, rejestr artefaktów B+R, wskaźniki przychodów oraz metryki jakości, audytowalności i efektywności energetycznej.',
    ].join('\n\n'),
  },
  {
    section: '2.3',
    suffix: 'innowacja_produktowa_znaczacy_potencjal_gospodarczy_innowacji',
    value: [
      'RNM ma znaczący potencjał gospodarczy, ponieważ jest bazową technologią modelową dla wielu sektorów UE, a nie jednorazowym narzędziem projektowym. Rynek docelowy obejmuje przedsiębiorstwa i instytucje wdrażające generatywną AI w środowiskach wymagających kontroli, audytu, bezpieczeństwa danych i zgodności z AI Act. Najbliższy segment komercyjny to usługi AI governance, audyt modeli, lokalne modele dla sektorów regulowanych oraz narzędzia kontroli zachowania modeli.',
      'Pierwszy etap wdrożenia zakłada realistyczną komercjalizację po zakończeniu projektu: sześciu klientów enterprise w pierwszym pełnym roku sprzedaży 2030, średni roczny kontrakt ok. 150 tys. USD i przychód 3,6 mln PLN zgodny z modelem finansowym. Kolejne lata monitorowania zakładają skalowanie w UE przez licencje, subskrypcje i wdrożenia asystowane. Długoterminowy potencjał jest większy, ale we wskaźnikach przyjęto konserwatywny pierwszy rok po wdrożeniu.',
      'Potencjał wykracza poza Polskę, ponieważ problem zgodności i audytu generatywnej AI jest wspólny dla rynku wewnętrznego UE. Produkt może być używany w wielu językach, w wielu jurysdykcjach państw członkowskich i przez podmioty o podobnych obowiązkach regulacyjnych. RNM umożliwiają budowę usług na bazie modeli kontrolowanych w UE, co wspiera rozwój lokalnych kompetencji, ogranicza zależność od amerykańskich i chińskich modeli oraz zwiększa odporność europejskiego łańcucha wartości AI.',
      'Przewagi względem konkurencji są konkretne: kontrola zachowania na poziomie reprezentacji, katalog konceptów możliwy do audytu, mniejszy koszt adaptacji niż pełny retraining, mniejsza potrzeba zewnętrznych moderatorów i możliwość lokalnego wdrożenia w UE. Ekonomiczna opłacalność jest mierzona przychodami ze sprzedaży produktu RNM, liczbą wdrożeń, liczbą przedsiębiorstw wprowadzających innowację produktową oraz nowymi miejscami pracy związanymi z komercjalizacją w UE.',
    ].join('\n\n'),
  },
  {
    section: '3.2',
    suffix: 'innowacja_produktowa_plan_wprowadzenia',
    value: [
      'Wdrożenie wyników prac B+R nastąpi po zakończeniu projektu, nie później niż 5 lat od jego zakończenia, przy czym planowana data pierwszego wdrożenia to wrzesień 2029 r. Projekt finansuje wyłącznie prace B+R potrzebne do opracowania i walidacji technologii RNM. Komercjalizacja, sprzedaż, utrzymanie produkcyjne, obsługa klientów i bieżące usługi wdrożeniowe będą realizowane poza projektem ze środków własnych Wisent Polska lub z przychodów komercyjnych.',
      'Podstawową formą wdrożenia będzie wprowadzenie produktu Wisent RNM Platform do własnej działalności gospodarczej Wisent Polska na terytorium RP i rynku UE. Produkt obejmie wersjonowane modele RNM, bibliotekę wisent-rnm, katalog konceptów, skrypty ewaluacyjne, karty modeli i dokumentację techniczną. Wdrożenie zostanie potwierdzone przez manifest artefaktów, rejestr wersji, decyzję o wprowadzeniu produktu, ofertę handlową, pierwszą umowę lub fakturę oraz logi użycia systemu.',
      'Drugą formą będzie udzielanie licencji podmiotom zarejestrowanym w UE, na zasadach rynkowych i bez sublicencjonowania jako celu samego w sobie. Licencjobiorca będzie zobowiązany do wykorzystania wyników prac B+R we własnej działalności gospodarczej na terytorium UE. Umowy będą obejmować zakres praw, wersję modeli, obowiązki bezpieczeństwa, warunki audytu i zakaz przeniesienia poza kontrolowany zakres użycia.',
      'Plan wejścia na rynek jest sekwencyjny. W III kwartale 2029 r. nastąpi zamknięcie artefaktów B+R, audyt kompletności dokumentacji technicznej i przygotowanie wydania produktu. W IV kwartale 2029 r. rozpocznie się wdrożenie we własnej działalności oraz rozmowy licencyjne z pierwszymi klientami. W 2030 r. planowany jest pierwszy pełny rok sprzedaży, z celem 3,6 mln PLN przychodów przy sześciu klientach enterprise z UE. Model sprzedaży obejmuje licencje, subskrypcje i wdrożenia asystowane finansowane poza projektem.',
      'Opłacalność wdrożenia wynika z połączenia wysokiej wartości regulacyjnej produktu, rosnącego popytu na audytowalne modele AI oraz przewagi kosztowej RNM. Klienci z sektorów regulowanych nie kupują wyłącznie dostępu do modelu, lecz kontrolę, możliwość audytu, lokalne wdrożenie i zgodność z AI Act. To odróżnia produkt od typowych usług API modeli zamkniętych i wspiera ograniczenie strategicznej zależności UE.',
    ].join('\n\n'),
  },
];

const taskRepairs = [
  {
    nr: '1',
    name: 'Eksperymentalne opracowanie architektury RNM i funkcji celu dla stabilnych reprezentacji konceptów',
    scope: [
      'Zadanie obejmuje badania przemysłowe ukierunkowane na rozwiązanie konkretnej niepewności technologicznej: czy można trenować model generatywny tak, aby wybrane koncepty bezpieczeństwa, prawdziwości, odmowy treści szkodliwych i zgodności regulacyjnej powstawały jako stabilne, separowalne i lokalnie edytowalne kierunki w przestrzeni aktywacji. Nie jest to badanie podstawowe ani opis koncepcyjny architektury; każdy wariant funkcji celu jest implementowany i weryfikowany eksperymentalnie na prototypach 100M parametrów.',
      'Prace obejmują trzy rodziny funkcji celu: contrastive separation, sparsity-induced disentanglement i probe-disentanglement, budowę korpusu par kontrastywnych dla co najmniej 1000 konceptów, kalibrację wag mieszania straty oraz porównanie z klasycznym transformerem tej samej skali. Wynikiem zadania ma być wybór wariantów, które spełniają minimalne progi stabilności, lokalności i jakości generacji, albo ich odrzucenie przed skalowaniem w zadaniu 2.',
    ].join(' '),
    detail: [
      'Metoda badawcza ma charakter iteracyjny i empiryczny. Zespół implementuje wariant funkcji celu, trenuje serię modeli 100M parametrów w kontrolowanych warunkach, mierzy stabilność kierunków między checkpointami, separowalność konceptów, wpływ interwencji na kompetencje poboczne i zmianę jakości generacji względem modelu referencyjnego. Każdy eksperyment ma manifest danych, konfigurację hiperparametrów, hash kodu, logi treningu i wynik ewaluacji.',
      'Niepewność technologiczna polega na tym, że znane metody post-hoc steeringu wykrywają kierunki w modelach już wytrenowanych, ale nie dowodzą, że stabilna geometria reprezentacji może być narzucona w procesie treningu bez utraty jakości. Zadanie usuwa tę niepewność przez systematyczne porównanie funkcji celu i warunków treningu. Próg kontynuacji do skali 1B obejmuje jednoczesne spełnienie wymagań jakości generacji, stabilności kierunków i lokalności interwencji.',
      'Artefakty zadania to kod eksperymentów, zestaw danych konceptów, wyniki ablation study, tabele parametrów, checkpointy prototypowe i decyzja techniczna wskazująca warianty architektury dopuszczone do skalowania. Same opracowania opisowe nie zaliczają zadania; podstawą są wyniki pomiarów i możliwość odtworzenia eksperymentów.',
    ].join(' '),
  },
  {
    nr: '4',
    name: 'Walidacja porównawcza RNM 1B-70B i decyzja techniczna o gotowości wyników do prototypu',
    scope: [
      'Zadanie obejmuje badania przemysłowe polegające na porównaniu modeli RNM 1B, 8B, 30B i 70B z modelami referencyjnymi trenowanymi na tym samym korpusie i w tym samym reżimie obliczeniowym. Celem nie jest przygotowanie raportu jako rezultatu, lecz techniczna decyzja, czy RNM spełniają mierzalne progi jakości, efektywności danych, stabilności reprezentacji, lokalności interwencji i kompletności śladu audytowego.',
      'Walidacja obejmuje benchmarki jakości generacji, ale benchmark nie jest samodzielnym kamieniem milowym. Jest jednym ze źródeł danych obok logów treningowych, krzywych uczenia, pomiarów energii, metryk reprezentacyjnych, testów interwencji i analiz przypadków niepowodzeń. Wyniki decydują o tym, które elementy można zintegrować w prototypie technologicznym w zadaniu 5.',
    ].join(' '),
    detail: [
      'Metoda badawcza polega na uruchomieniu zunifikowanego pipeline ewaluacyjnego dla RNM i modeli referencyjnych. Dla każdego modelu zapisywane są: wersja kodu, manifest danych, konfiguracja treningu, liczba tokenów, koszt obliczeniowy, wyniki benchmarków, metryki stabilności kierunków, skuteczność interwencji, degradacja kompetencji pobocznych i kompletność logów audytowych. Porównanie jest wykonywane w identycznych warunkach sprzętowych i programowych.',
      'Najważniejsza niepewność dotyczy tego, czy wzrost skali modelu zachowuje własności reprezentacyjne uzyskane w mniejszych prototypach. Jeżeli RNM 70B osiąga jakość generacji zbliżoną do modelu referencyjnego przy niższym koszcie tokenów i zachowuje lokalną kontrolę konceptów, technologia przechodzi do integracji. Jeżeli właściwości zanikają przy skali, zespół identyfikuje przyczynę i ogranicza zakres prototypu albo wraca do korekty funkcji celu.',
      'Dowodami są surowe pliki JSON/CSV z wynikami, logi treningowe i inferencyjne, manifesty modeli, skrypty liczące metryki, rejestr decyzji technicznych oraz zestawienie wariantów dopuszczonych do zadania 5. Dokument podsumowujący jest tylko indeksem dowodów, nie kamieniem samym w sobie.',
    ].join(' '),
  },
];

const indicatorRepairs = [
  {
    name: 'Liczba wdrożonych wyników prac B+R',
    year: '2029',
    methodology: 'Wskaźnik liczy jedno wdrożenie wyników B+R projektu RNM po zakończeniu prac: użycie rodziny modeli RNM, biblioteki interwencji lub katalogu konceptów w działalności Wisent Polska albo u licencjobiorcy z UE. Do licznika trafia wyłącznie wdrożenie powiązane z konkretną wersją modelu, manifestem artefaktów, datą uruchomienia, zakresem funkcji oraz dowodem wykorzystania. Nie wlicza się demonstracji, testów jednorazowych, publikacji repozytorium ani materiałów promocyjnych.',
    verification: 'Weryfikacja opiera się na rejestrze wdrożeń RNM zawierającym identyfikator wdrożenia, wersję modelu, hash artefaktów, zakres funkcji, datę uruchomienia i podmiot korzystający. Dowodami są decyzja o wdrożeniu, umowa licencyjna lub wdrożeniowa, faktura albo wewnętrzny protokół produkcyjnego użycia, logi dostępowe i manifest techniczny. Weryfikator sprawdza, czy wdrożenie dotyczy wyników B+R, a nie zwykłej publikacji kodu.',
  },
  {
    name: 'Liczba wprowadzonych innowacji produktowych',
    year: '2029',
    methodology: 'Wskaźnik liczy jedną innowację produktową: Wisent RNM Platform, czyli rodzinę modeli RNM z katalogiem konceptów, biblioteką interwencji i mechanizmem audytu reprezentacyjnego. Innowacja jest liczona po spełnieniu trzech warunków: istnieje wersjonowany artefakt produktu, opisane są funkcje odróżniające RNM od modeli referencyjnych, a produkt jest udostępniony użytkownikom lub klientom na rynku UE. Benchmarki są danymi pomocniczymi; podstawą jest fakt wprowadzenia produktu.',
    verification: 'Weryfikator porównuje kartę produktu RNM, manifest modeli, dokumentację funkcji reprezentacyjnych, repozytorium biblioteki i dowody udostępnienia produktu. Sprawdza, czy produkt obejmuje sterowanie konceptami, ślad audytowy i integrację z modelem RNM, a nie usługę konsultingową albo standardowy transformer. Dodatkowymi dowodami są umowy licencyjne, faktury, data wydania artefaktów i lista funkcji dostępnych w produkcie.',
  },
  {
    name: 'Liczba wprowadzonych innowacji procesowych',
    year: '2029',
    methodology: 'Wskaźnik pozostaje równy 0, ponieważ projekt deklaruje innowację produktową, a nie procesową. Wyliczenie polega na sprawdzeniu, czy w dokumentacji projektu nie wskazano odrębnej zmiany procesu produkcji, logistyki, zarządzania jakością, dostaw, obsługi klienta lub organizacji pracy jako rezultatu dofinansowanego projektu. Pipeline treningowy i walidacyjny są środkiem B+R prowadzącym do produktu RNM, nie samodzielną innowacją procesową.',
    verification: 'Weryfikacja polega na przeglądzie klasyfikacji innowacji w sekcji 2.2, rejestru rezultatów projektu oraz opisów wdrożenia. Wartość 0 jest potwierdzona, jeżeli jedynym rezultatem rynkowym jest produkt RNM, a dokumentacja nie zawiera odrębnego wdrożenia procesu wewnętrznego jako innowacji. Dowodem jest rejestr innowacji podpisany przez spółkę i zestawienie rezultatów bez pozycji procesowej.',
  },
  {
    name: 'Przedsiębiorstwa wprowadzające innowacje produktowe lub procesowe',
    year: '2029',
    methodology: 'Wskaźnik liczy przedsiębiorstwa, które wprowadziły innowację powstałą w projekcie. W tym projekcie licznikiem jest Wisent Polska jako beneficjent wdrażający innowację produktową RNM. Nie dolicza się klientów testowych ani podmiotów uczestniczących w walidacji technicznej, jeżeli nie wprowadzają u siebie innowacji jako własnego produktu lub procesu. Wartość 1 oznacza jedno przedsiębiorstwo wdrażające produkt RNM.',
    verification: 'Weryfikacja obejmuje rejestr innowacji Wisent Polska, dokument wdrożenia produktu RNM, dokumenty rejestrowe spółki i dowód udostępnienia produktu na rynku UE. Sprawdza się, czy beneficjent faktycznie wprowadził innowację produktową, a nie tylko zakończył prace badawcze. Dowodami są manifest produktu, data wydania, umowa lub faktura oraz zapis decyzji o wprowadzeniu produktu.',
  },
  {
    name: 'Przedsiębiorstwa wprowadzające innowacje produktowe',
    year: '2029',
    methodology: 'Wskaźnik liczy przedsiębiorstwa wprowadzające innowację produktową. Wartość docelowa 1 obejmuje Wisent Polska, ponieważ rezultatem projektu jest produkt RNM, a nie sama metoda badawcza. Warunkiem zaliczenia jest dostępny artefakt produktu: wersja modeli, biblioteka, katalog konceptów i funkcje audytu/interwencji. Klienci i partnerzy walidacyjni nie są liczeni, chyba że odrębnie wprowadzą własną innowację produktową.',
    verification: 'Weryfikator sprawdza zestaw artefaktów produktu RNM: wersjonowane modele, bibliotekę, katalog konceptów, opis funkcji, datę udostępnienia i dokument sprzedażowy lub licencyjny. Wartość 1 jest uznana, gdy Wisent Polska wprowadziła produkt na rynek UE lub do własnej działalności gospodarczej w sposób udokumentowany. Same wyniki benchmarków i publikacje naukowe nie wystarczają.',
  },
  {
    name: 'Przedsiębiorstwa wprowadzające innowacje procesowe',
    year: '2029',
    methodology: 'Wartość docelowa wynosi 0, ponieważ projekt nie przewiduje wprowadzenia innowacji procesowej jako rezultatu. Wyliczenie jest negatywne: sprawdza się, czy żadne przedsiębiorstwo, w tym Wisent Polska, nie deklaruje w ramach projektu nowego procesu produkcji, logistyki, zarządzania lub dostarczania usług jako osobnej innowacji. Zmiany narzędziowe potrzebne do wytworzenia RNM nie są liczone jako wdrożony proces.',
    verification: 'Weryfikacja polega na przeglądzie rejestru innowacji, dokumentów wdrożeniowych i ewidencji rezultatów. Wartość 0 jest potwierdzona, jeżeli dokumenty wskazują wyłącznie innowację produktową i brak odrębnych procesów wdrożonych jako rezultat projektu. Dowodami są klasyfikacja z sekcji 2.2, rejestr rezultatów i oświadczenie spółki o braku innowacji procesowej.',
  },
  {
    name: 'Małe i średnie przedsiębiorstwa (MŚP) wprowadzające innowacje produktowe lub procesowe',
    year: '2029',
    methodology: 'Wskaźnik liczy MŚP, które wprowadziły innowację produktową lub procesową. W projekcie liczy się Wisent Polska, jeżeli na dzień rozliczenia zachowuje status MŚP i wprowadza produkt RNM. Metodologia łączy dwie weryfikacje: status przedsiębiorstwa według definicji MŚP oraz fakt wprowadzenia innowacji produktowej. Nie liczy się partnerów, dostawców compute ani użytkowników testowych.',
    verification: 'Dowody obejmują dokumenty KRS, dane zatrudnienia i finansowe potrzebne do statusu MŚP, rejestr innowacji, manifest produktu RNM oraz dokument wdrożenia lub sprzedaży. Weryfikator sprawdza aktualność statusu MŚP oraz związek innowacji z wynikami projektu. Wartość 1 jest przyjęta tylko wtedy, gdy oba warunki są spełnione jednocześnie.',
  },
  {
    name: 'Małe i średnie przedsiębiorstwa (MŚP) wprowadzające innowacje procesowe',
    year: '2029',
    methodology: 'Wartość wskaźnika wynosi 0, ponieważ Wisent Polska jako MŚP nie wprowadza w projekcie innowacji procesowej. Wyliczenie polega na sprawdzeniu braku procesowego rezultatu w dokumentacji oraz potwierdzeniu, że wszystkie prace nad pipeline, walidacją i integracją służą opracowaniu produktu RNM. Nie tworzy się osobnego procesu biznesowego jako rezultatu wskaźnikowego.',
    verification: 'Weryfikacja wykorzystuje rejestr rezultatów, sekcję 2.2, dokumenty wdrożeniowe oraz oświadczenie spółki. Wartość 0 jest potwierdzona, gdy dokumenty nie wskazują żadnej procesowej innowacji MŚP, a jedyny rezultat to produkt RNM. Kontrola statusu MŚP jest pomocnicza i nie zmienia wartości, ponieważ liczba procesowych innowacji pozostaje zerowa.',
  },
  {
    name: 'Małe i średnie przedsiębiorstwa (MŚP) wprowadzające innowacje produktowe',
    year: '2029',
    methodology: 'Wskaźnik liczy MŚP, które wprowadziły innowację produktową. Wartość 1 oznacza Wisent Polska jako MŚP wprowadzające produkt RNM. Zaliczenie wymaga jednocześnie potwierdzenia statusu MŚP oraz udostępnienia produktu obejmującego modele RNM, bibliotekę, katalog konceptów i funkcje audytu/interwencji. Wartość nie obejmuje podmiotów korzystających z produktu ani dostawców infrastruktury.',
    verification: 'Weryfikator sprawdza dokumenty statusu MŚP, rejestr innowacji, manifest modeli RNM, repozytorium biblioteki, datę wydania i dowód udostępnienia produktu na rynku UE. Źródłami są KRS, dane finansowe i zatrudnieniowe, karta produktu, umowa licencyjna lub faktura. Wartość 1 jest uznana wyłącznie po potwierdzeniu obu elementów: statusu MŚP i faktycznego wprowadzenia innowacji produktowej.',
  },
  {
    name: 'Złożone wnioski patentowe',
    year: '2029',
    methodology: 'Wartość wskaźnika wynosi 0, ponieważ projekt nie planuje zgłoszeń patentowych jako rezultatu. Strategia ochrony polega na kontroli praw autorskich do kodu, tajemnicy przedsiębiorstwa dla wybranych procedur operacyjnych, licencjach na modele i bibliotekę oraz publicznym udostępnieniu wybranych artefaktów w sposób wzmacniający europejski ekosystem AI. Brak zgłoszeń patentowych nie oznacza braku ochrony IP, lecz świadomy wybór mechanizmu ochrony odpowiedniego dla oprogramowania AI.',
    verification: 'Weryfikacja wartości 0 polega na przeglądzie rejestru decyzji IP, rejestru zgłoszeń patentowych, repozytoriów kodu, licencji i dokumentacji praw autorskich. Dowodem jest oświadczenie spółki i rejestr IP wskazujący, że w okresie realizacji projektu nie dokonano zgłoszenia patentowego jako rezultatu dofinansowanych prac. Ewentualna późniejsza decyzja biznesowa poza zakresem wskaźnika nie zmienia wartości docelowej projektu.',
  },
  {
    name: 'Miejsca pracy utworzone we wspieranych jednostkach',
    year: '2030',
    methodology: 'Wskaźnik liczony jest jako liczba nowych miejsc pracy w pełnych równoważnikach czasu pracy, utworzonych w Wisent Polska w związku z komercjalizacją produktu RNM. Wartość bazowa wynosi 0. Wartość docelowa obejmuje stanowiska badawcze, inżynierskie, produktowe, wdrożeniowe i wsparcia technicznego związane z utrzymaniem oraz sprzedażą produktu RNM na rynku UE. Do wskaźnika nie wlicza się krótkich usług zewnętrznych ani dostawców infrastruktury.',
    verification: 'Weryfikacja opiera się na umowach o pracę lub kontraktach, listach płac, ewidencji czasu pracy, strukturze organizacyjnej i opisie powiązania stanowisk z produktem RNM. Weryfikator przelicza zatrudnienie na pełne równoważniki czasu pracy i sprawdza, czy miejsca pracy powstały po wdrożeniu produktu oraz są zlokalizowane w UE. Dowodami są dokumenty kadrowe, rejestr stanowisk i raport z powiązania kosztów zatrudnienia z komercjalizacją RNM.',
  },
  {
    name: 'Przychody ze sprzedaży nowych lub udoskonalonych produktów/usług',
    year: '2029',
    methodology: 'Wskaźnik oblicza się jako wartość przychodów lub wiążących kontraktów sprzedażowych dla produktów i usług opartych na wynikach projektu RNM osiągniętą do końca 2029 r., po pierwszym wdrożeniu produktu. Zakres obejmuje licencje, subskrypcje enterprise i wdrożenia asystowane produktu RNM dla podmiotów z UE. Wartość docelowa 3 600 000 PLN odpowiada rocznej wartości zakontraktowanej sprzedaży: sześciu klientom enterprise, średniej wartości kontraktu ok. 150 000 USD i kursowi 4,00 PLN/USD.',
    verification: 'Weryfikacja opiera się na umowach licencyjnych lub subskrypcyjnych, zamówieniach, fakturach zaliczkowych lub sprzedażowych, ewidencji przychodów, rejestrze kontrahentów i harmonogramach rozliczeń. Sprawdza się, czy kontrakty dotyczą produktu RNM, czy kontrahenci działają na rynku UE oraz czy łączna wartość sprzedaży zakontraktowanej lub zafakturowanej do końca 2029 r. odpowiada wartości docelowej wskaźnika.',
  },
  {
    name: 'Przychody uzyskane z innowacji w procesie biznesowym',
    year: '2030',
    methodology: 'Wartość docelowa wynosi 0 PLN, ponieważ projekt nie deklaruje innowacji procesowej jako rezultatu rynkowego. Przychody ze sprzedaży dotyczą produktu RNM i są raportowane we wskaźniku przychodów z nowych lub udoskonalonych produktów/usług. Ten wskaźnik pozostaje zerowy, aby uniknąć podwójnego liczenia i zachować spójność z klasyfikacją innowacji produktowej w sekcji 2.2.',
    verification: 'Weryfikacja polega na przeglądzie klasyfikacji innowacji, ewidencji przychodów i rejestru umów. Wartość 0 jest potwierdzona, jeżeli żaden przychód nie został przypisany do innowacji procesowej, a wszystkie przychody z rezultatów projektu są klasyfikowane jako przychody z produktu RNM. Dowodami są raport końcowy, zestawienie przychodów według źródła i oświadczenie o braku innowacji procesowej.',
  },
  {
    name: 'Redukcja ilości tokenów treningowych dla RNM 70B wobec modelu odniesienia (transformer) do osiągnięcia parytetu jakości na MMLU',
    year: '2029',
  },
  {
    name: 'Udział cykli treningowych RNM z pomiarem energii, CO2eq i kryteriami zielonych zamówień',
    year: '2029',
  },
  {
    name: 'Liczba przedsięwzięć proekologicznych',
    year: '2029',
  },
];

const session = await WSession.start({ label: 'ncbr_repair_strict_criteria_wsession', proxy: 'direct', browser: 'chromium' });
const page = session.page;
page.setDefaultTimeout(30000);

async function setReactInputValue(locator, value) {
  await locator.waitFor({ state: 'visible' });
  await locator.click({ force: true }); // allow-raw-playwright: focus visible LSI input
  const max = Number(await locator.getAttribute('maxlength')) || String(value || '').length;
  let next = String(value || '');
  if (next.length > max) next = next.slice(0, max).replace(/\s+\S*$/, '');
  const locked = await locator.evaluate((el) => Boolean(el.readOnly || el.disabled)); // allow-raw-playwright: inspect visible field mutability
  if (!locked) {
    await locator.fill(''); // allow-raw-playwright: clear editable LSI field
    await locator.fill(next); // allow-raw-playwright: fill editable LSI field
  }
  await locator.evaluate((el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, v);
    else el.value = v;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: v }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, next); // allow-raw-playwright: set React-controlled LSI value
  await humanIdlePause('short');
  return { len: next.length, max };
}

async function login() {
  await page.goto('https://lsi2.ncbr.gov.pl/logowanie', { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: LSI login page
  await humanIdlePause('long');
  await setReactInputValue(page.locator('#mail, input[name="mail"]').first(), email);
  await setReactInputValue(page.locator('#password, input[name="password"]').first(), password);
  await page.evaluate(() => {
    const input = document.querySelector('#isStatuteAccepted, input[name="isStatuteAccepted"]');
    if (!input || input.checked) return;
    const target = input.closest('label') || input.closest('.MuiFormControlLabel-root') || input.closest('.MuiCheckbox-root') || input;
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    if (!input.checked) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set?.call(input, true);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }); // allow-raw-playwright: accept visible statute checkbox only
  await humanIdlePause('short');
  await page.waitForFunction(() => {
    const btn = document.querySelector('#login-btn') || Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Zaloguj');
    return !!btn && !btn.disabled;
  }, null, { timeout: 10000 }).catch(() => null); // allow-raw-playwright: wait for login form validation
  for (let attempt = 1; attempt <= 3 && page.url().includes('/logowanie'); attempt += 1) {
    if (attempt === 1) {
      await page.locator('#login-btn, button:has-text("Zaloguj")').first().click({ force: true }); // allow-raw-playwright: click visible login button
    } else {
      await page.evaluate(() => {
        const btn = document.querySelector('#login-btn') || Array.from(document.querySelectorAll('button')).find((b) => b.innerText.includes('Zaloguj'));
        if (!btn) throw new Error('login button not found for retry');
        for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }); // allow-raw-playwright: retry visible login button dispatch
    }
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
    await humanIdlePause('long');
  }
  if (page.url().includes('/logowanie')) throw new Error('login stayed on login page');
}

async function fillBySuffix(suffix, value) {
  const visible = page.locator(`[name$="${suffix}"]:visible`);
  const loc = (await visible.count() > 0) ? visible.last() : page.locator(`[name$="${suffix}"]`).last();
  const res = await setReactInputValue(loc, value);
  return { suffix, ...res };
}

async function fillByExactName(name, value) {
  const visible = page.locator(`[name="${name}"]:visible`);
  const loc = (await visible.count() > 0) ? visible.last() : page.locator(`[name="${name}"]`).last();
  const res = await setReactInputValue(loc, value);
  return { name, ...res };
}

async function saveVisibleForm() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  await page.evaluate(() => {
    const saves = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled && b.getClientRects().length);
    if (!saves.length) throw new Error('no enabled visible Zapisz');
    saves[saves.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: save visible LSI section/form only
  await humanIdlePause('long');
}

async function closeVisibleForm() {
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Anuluj' && b.getClientRects().length);
    if (buttons.length) buttons[buttons.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: close visible row form without submit
  await humanIdlePause('long');
}

async function repairScalarSections() {
  const out = [];
  for (const item of scalarRepairs) {
    console.log(`[scalar] ${item.section} ${item.suffix}`);
    await page.goto(URLS[item.section], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section navigation
    await humanIdlePause('long');
    out.push({ section: item.section, ...(await fillBySuffix(item.suffix, item.value)) });
    await saveVisibleForm();
  }
  return out;
}

async function openTaskRow(nr) {
  await page.goto(URLS['6.1'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 6.1 navigation
  await humanIdlePause('long');
  await page.evaluate((taskNr) => {
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    const row = rows.find((r) => {
      const first = r.querySelector('td');
      const text = (first?.getAttribute('title') || first?.textContent || '').trim();
      return text.startsWith(`${taskNr}. `);
    });
    if (!row) throw new Error(`task row not found: ${taskNr}`);
    const btn = row.querySelector('button[aria-label="overflow-options"]');
    if (!btn) throw new Error(`task row menu not found: ${taskNr}`);
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }, String(nr)); // allow-raw-playwright: open exact visible task row menu
  await humanIdlePause('deliberate');
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit task row
  await humanIdlePause('long');
  await page.waitForSelector('[name="nazwa_zadania"]');
}

async function repairTasks61() {
  const out = [];
  for (const task of taskRepairs) {
    console.log(`[6.1] task ${task.nr}`);
    await openTaskRow(task.nr);
    const filled = [];
    filled.push(await setReactInputValue(page.locator('[name="nazwa_zadania"]').first(), task.name));
    filled.push(await setReactInputValue(page.locator('[name="zakres_planowanych_prac_br"]').first(), task.scope));
    filled.push(await setReactInputValue(page.locator('[name="szczegolowy_opis_prac"]').first(), task.detail));
    await saveVisibleForm();
    out.push({ nr: task.nr, filled });
  }
  return out;
}

async function openIndicatorRowExact(name) {
  await page.goto(URLS['9.2'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 9.2 navigation
  await humanIdlePause('long');
  await page.evaluate((indicatorName) => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    const row = rows.find((r) => norm(r.querySelector('td')?.innerText || r.querySelector('td')?.textContent) === indicatorName);
    if (!row) throw new Error(`indicator row not found: ${indicatorName}`);
    const btn = row.querySelector('button[aria-label="overflow-options"]');
    if (!btn) throw new Error(`indicator row menu not found: ${indicatorName}`);
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }, name); // allow-raw-playwright: exact first-cell row match in 9.2 table
  await humanIdlePause('deliberate');
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit exact indicator row
  await humanIdlePause('long');
  await page.waitForSelector('input, textarea');
}

async function openIndicatorRowByIndex(index) {
  await page.goto(URLS['9.2'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 9.2 navigation
  await humanIdlePause('long');
  await page.evaluate((rowIndex) => {
    const rows = Array.from(document.querySelectorAll('table tbody tr')).filter((row) => row.querySelector('button[aria-label="overflow-options"]'));
    const row = rows[rowIndex];
    if (!row) throw new Error(`indicator row index not found: ${rowIndex}`);
    const btn = row.querySelector('button[aria-label="overflow-options"]');
    if (!btn) throw new Error(`indicator row menu not found: ${rowIndex}`);
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }, index); // allow-raw-playwright: open 9.2 row menu by visible table index for diagnostics
  await humanIdlePause('deliberate');
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit indicator row by index
  await humanIdlePause('long');
  await page.waitForSelector('input, textarea');
}

async function repairIndicators92() {
  const out = [];
  const items = process.env.TAIL_92 === '1'
    ? indicatorRepairs.filter((item) => [
      'Redukcja ilości tokenów treningowych dla RNM 70B wobec modelu odniesienia (transformer) do osiągnięcia parytetu jakości na MMLU',
      'Udział cykli treningowych RNM z pomiarem energii, CO2eq i kryteriami zielonych zamówień',
      'Liczba przedsięwzięć proekologicznych',
    ].includes(item.name))
    : process.env.METH_92 === '1'
      ? indicatorRepairs.filter((item) => item.name === 'Liczba wprowadzonych innowacji procesowych')
    : process.env.REV_92 === '1'
      ? indicatorRepairs.filter((item) => item.name === 'Przychody ze sprzedaży nowych lub udoskonalonych produktów/usług')
    : process.env.ERROR_92 === '1'
      ? indicatorRepairs.filter((item) => [
        'Liczba wprowadzonych innowacji procesowych',
        'Przedsiębiorstwa wprowadzające innowacje procesowe',
        'Małe i średnie przedsiębiorstwa (MŚP) wprowadzające innowacje procesowe',
      ].includes(item.name))
    : indicatorRepairs;
  for (const item of items) {
    console.log(`[9.2] ${item.name}`);
    await openIndicatorRowExact(item.name);
    const filled = [];
    if (item.year && process.env.METH_92 !== '1') filled.push({ field: 'year', ...(await fillByExactName('rok_osiagniecia_wartosci_docelowej', item.year)) });
    if (item.methodology) filled.push({ field: 'methodology', ...(await fillByExactName('opis_metodologii', item.methodology)) });
    if (item.verification && process.env.METH_92 !== '1') filled.push({ field: 'verification', ...(await fillByExactName('opis_sposobu_weryfikacji', item.verification)) });
    let save = 'saved';
    try {
      await saveVisibleForm();
    } catch (e) {
      if (!/no enabled visible Zapisz/i.test(String(e?.message || e))) throw e;
      save = 'unchanged_or_readonly';
      await closeVisibleForm();
    }
    out.push({ name: item.name, save, filled });
  }
  return out;
}

async function validateProject() {
  const responses = [];
  page.on('response', async (res) => {
    if (!res.url().includes('/validate-project')) return;
    let text = '';
    try { text = await res.text(); } catch { text = ''; }
    responses.push({ status: res.status(), url: res.url(), text });
  });
  await page.goto(PROJECT_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: project page for validation-only action
  await humanIdlePause('long');
  const clicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Sprawdź wniosek' && !b.disabled);
    if (!btn) return { clicked: false, reason: 'enabled Sprawdz wniosek button not found' };
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return { clicked: true };
  }); // allow-raw-playwright: validation-only; never submit
  await humanIdlePause('long');
  await humanIdlePause('long');
  await humanIdlePause('long');
  const response = responses.at(-1) || null;
  if (!response) return { clicked, response: null };
  let parsed = null;
  try { parsed = JSON.parse(response.text); } catch {}
  const jsonSchemaErrors = [];
  const expressionErrors = [];
  if (parsed) {
    for (const sec of parsed.jsonSchemaValidationErrors || []) {
      for (const err of sec.validationResult?.errors || []) jsonSchemaErrors.push({ sectionId: sec.sectionId, dataPath: err.dataPath, message: err.message });
    }
    for (const sec of parsed.expressionValidationErrors || []) {
      for (const err of sec.validationResult?.errors || []) expressionErrors.push({ sectionId: sec.sectionId, dataPath: err.dataPath, message: err.message });
    }
  }
  return { clicked, status: response.status, jsonSchemaErrors, expressionErrors, rawHead: response.text.slice(0, 500) };
}

async function readback() {
  const out = {};
  await page.goto(PROJECT_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: read status only
  await humanIdlePause('long');
  out.status = await page.evaluate(() => {
    const body = document.body?.innerText || '';
    return {
      statusLines: body.split('\n').map((l) => l.trim()).filter((l) => /W przygotowaniu|Złożony|Konkurs:/i.test(l)).slice(0, 10),
      submitButtons: Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Złóż wniosek').map((b) => ({ disabled: b.disabled })),
    };
  }); // allow-raw-playwright: read application status and submit button state
  await page.goto(URLS['9.2'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: read 9.2 table only
  await humanIdlePause('long');
  out.indicators92 = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tbody tr')).map((r) => Array.from(r.querySelectorAll('td')).map((td) => td.innerText.trim().replace(/\s+/g, ' ')));
    return rows.map((cells) => ({ name: cells[0], year: cells[4], value: cells[5], methodologyHead: (cells[6] || '').slice(0, 120) }));
  }); // allow-raw-playwright: read 9.2 row cells after save
  await page.goto(URLS['6.1'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: read 6.1 table only
  await humanIdlePause('long');
  out.tasks61 = await page.evaluate(() => Array.from(document.querySelectorAll('table tbody tr')).map((r) => (r.querySelector('td')?.innerText || '').trim()).filter(Boolean));
  return out;
}

await login();
if (process.env.DIAG_92) {
  await openIndicatorRowExact(process.env.DIAG_92);
  const fields = await page.evaluate(() => Array.from(document.querySelectorAll('input, textarea')).map((el) => ({
    name: el.name || null,
    label: el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() : null,
    value: (el.value || '').slice(0, 220),
    len: (el.value || '').length,
    max: el.getAttribute('maxlength'),
    readOnly: el.readOnly,
    disabled: el.disabled,
    visible: Boolean(el.getClientRects().length),
  })).filter((x) => x.name || x.label)); // allow-raw-playwright: diagnostic read of exact open indicator row only
  console.log(JSON.stringify({ diag92: process.env.DIAG_92, fields }, null, 2));
  await session.ctx.close();
  process.exit(0);
}
if (process.env.DIAG_92_ALL === '1') {
  await page.goto(URLS['9.2'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 9.2 navigation
  await humanIdlePause('long');
  const count = await page.evaluate(() => Array.from(document.querySelectorAll('table tbody tr')).filter((row) => row.querySelector('button[aria-label="overflow-options"]')).length); // allow-raw-playwright: count editable indicator rows only
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    await openIndicatorRowByIndex(i);
    rows.push(await page.evaluate((idx) => {
      const val = (name) => document.querySelector(`[name="${name}"]`)?.value || '';
      return {
        index: idx,
        name: val('nazwa_wskaznika'),
        targetYear: val('rok_osiagniecia_wartosci_docelowej'),
        targetValue: val('wartosc_docelowa'),
        methodologyLen: val('opis_metodologii').length,
        verificationLen: val('opis_sposobu_weryfikacji').length,
        methodologyHead: val('opis_metodologii').slice(0, 120),
      };
    }, i)); // allow-raw-playwright: read exact open indicator row field values
    await closeVisibleForm();
  }
  console.log(JSON.stringify({ rows }, null, 2));
  await session.ctx.close();
  process.exit(0);
}
if (process.env.DIAG_92_INDEX !== undefined) {
  const idx = Number(process.env.DIAG_92_INDEX);
  await openIndicatorRowByIndex(idx);
  const row = await page.evaluate((index) => {
    const val = (name) => document.querySelector(`[name="${name}"]`)?.value || '';
    return {
      index,
      name: val('nazwa_wskaznika'),
      baseYear: val('rok_bazowy'),
      targetYear: val('rok_osiagniecia_wartosci_docelowej'),
      targetValue: val('wartosc_docelowa'),
      methodologyLen: val('opis_metodologii').length,
      verificationLen: val('opis_sposobu_weryfikacji').length,
      methodologyHead: val('opis_metodologii').slice(0, 160),
      verificationHead: val('opis_sposobu_weryfikacji').slice(0, 160),
    };
  }, idx); // allow-raw-playwright: diagnostic read of one 9.2 row by collection-visible index
  console.log(JSON.stringify({ row }, null, 2));
  await session.ctx.close();
  process.exit(0);
}
if (process.env.VALIDATE_ONLY === '1') {
  const validation = await validateProject();
  const evidence = await readback();
  console.log(JSON.stringify({ validation, evidence }, null, 2));
  await session.ctx.close();
  process.exit(0);
}
const only92 = process.env.TAIL_92 === '1' || process.env.ERROR_92 === '1' || process.env.METH_92 === '1' || process.env.REV_92 === '1';
const scalar = only92 ? [] : await repairScalarSections();
const tasks61 = only92 ? [] : await repairTasks61();
const indicators92 = await repairIndicators92();
const validation = await validateProject();
const evidence = await readback();

console.log(JSON.stringify({ scalar, tasks61, indicators92, validation, evidence }, null, 2));
await session.ctx.close();
process.exit(0);
