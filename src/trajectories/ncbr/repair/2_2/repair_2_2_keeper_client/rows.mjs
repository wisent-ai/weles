// The 2.2 rows: every factor the form knows, the extra features, and the factor rows.

export const ALL_FACTORS = [
  'przyczynia się do wiodącej pozycji Unii w dziedzinie przemysłu i technologii',
  'stanowi wkład w infrastrukturę krytyczną na szczeblu europejskim',
  'wpływa na zwiększenie zdolności produkcyjnych',
  'wpływa na zwiększenie bezpieczeństwa dostaw',
  'skutkuje promowaniem pozytywnych skutków transgranicznych na rynku wewnętrznym',
];

export const EXTRA_FEATURES = [
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

export const FACTOR_ROWS = [
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

