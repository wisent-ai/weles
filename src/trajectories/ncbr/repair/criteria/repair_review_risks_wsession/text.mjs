// The text repair_review_risks_wsession.mjs writes: task 5, the 9.2 indicators and the 4.1 management description.

export const task5 = {
  name: 'Integracja wyników B+R RNM w prototyp technologiczny i walidacja techniczna w warunkach zbliżonych do operacyjnych',
  scope: [
    'Zadanie obejmuje prace rozwojowe polegające na połączeniu wyników badań przemysłowych z Zadań 1-4 w działający prototyp technologiczny RNM. Zakres dotyczy integracji wytrenowanych wag modeli, katalogu kierunków konceptów, procedur interwencji w reprezentacje, mechanizmów logowania śladu audytowego oraz interfejsu testowego używanego do walidacji technicznej.',
    'Prace nie obejmują rutynowego utrzymania systemu, działań marketingowych, sprzedaży, obsługi klientów ani zwykłej publikacji dokumentacji. Celem jest sprawdzenie, czy komponenty opracowane w części badawczej mogą działać łącznie w prototypie gotowym do późniejszego wdrożenia w UE, przy zachowaniu mierzalnych właściwości B+R: lokalności interwencji, stabilności kierunków konceptów, kompletności śladu audytowego i akceptowalnej degradacji jakości generacji.',
  ].join(' '),
  detail: [
    'Metoda prac rozwojowych polega na iteracyjnej integracji komponentów RNM i testowaniu ich w kontrolowanych scenariuszach technicznych. W pierwszym kroku zespół łączy checkpointy modeli RNM 1B-70B z katalogiem konceptów oraz biblioteką interwencji. Następnie przygotowuje powtarzalne scenariusze walidacyjne dla sektorów regulowanych UE: odmowa treści szkodliwych, ograniczanie halucynacji, zachowanie kompetencji po interwencji, audyt przyczyny wygenerowanego tokenu oraz zgodność śladu decyzyjnego z wymaganiami dokumentacyjnymi AI Act.',
    'W drugim kroku zespół porównuje zachowanie prototypu z wynikami uzyskanymi w badaniach przemysłowych. Każda zmiana integracyjna jest oceniana na danych testowych, logach aktywacji, wynikach benchmarków oraz metrykach lokalności i stabilności reprezentacji. Jeżeli integracja pogarsza jakość generacji albo powoduje niekontrolowany wpływ interwencji na kompetencje poboczne, rozwiązanie wraca do korekty architektury lub konfiguracji. Kryteria akceptacji są techniczne: kompletność katalogu konceptów w prototypie, powtarzalność interwencji, zapis metadanych audytu, zgodność wersji modeli i reprodukowalny pipeline ewaluacyjny.',
    'Elementy takie jak model card, repozytorium biblioteki, przykłady użycia i opis API są w tym zadaniu traktowane wyłącznie jako artefakty techniczne potrzebne do uruchomienia, przetestowania i zweryfikowania prototypu. Nie stanowią samodzielnego celu projektu ani kosztu komercjalizacji. Walidacja z użytkownikami ma charakter techniczny i służy sprawdzeniu użyteczności prototypu RNM w realistycznych scenariuszach, a nie świadczeniu usług produkcyjnych.',
  ].join(' '),
  milestones: [
    {
      name: 'Prototyp integracyjny RNM z katalogiem konceptów i interfejsem walidacyjnym',
      params: 'Prototyp zawiera co najmniej modele RNM 1B i 8B, katalog min. 1000 kierunków konceptów, bibliotekę interwencji, zapis śladu audytowego i scenariusze testowe. Dla każdego uruchomienia zapisuje wersję modelu, hash danych, konfigurację, identyfikator konceptu, wynik interwencji i metryki jakości.',
      verify: 'Weryfikacja odbywa się przez uruchomienie pipeline testowego na zamrożonym zestawie scenariuszy. Dowodami są repozytorium kodu, hash commita, manifest modeli, logi aktywacji, pliki JSON/CSV z wynikami, checklisty integracyjne i powtarzalny skrypt uruchomienia. Sama dokumentacja opisowa nie wystarcza do zaliczenia kamienia.',
      impact: 'Nieosiągnięcie kamienia oznacza, że wyniki badań nie zostały zintegrowane w spójny prototyp i nie można wykonać walidacji technicznej. Wymaga to powrotu do korekty interfejsów komponentów, wersjonowania modeli lub procedury ekstrakcji konceptów; może opóźnić wdrożenie, ale nie zmienia celu B+R.',
    },
    {
      name: 'Walidacja techniczna RNM w scenariuszach sektorów regulowanych UE',
      params: 'Walidacja obejmuje scenariusze odmowy treści szkodliwych, redukcji halucynacji, zachowania kompetencji po interwencji i kompletności audytu. Dla każdego scenariusza mierzy się skuteczność interwencji, zmianę perplexity lub jakości zadaniowej, liczbę naruszonych kompetencji pobocznych oraz kompletność śladu audytowego.',
      verify: 'Dowodami są surowe wyniki testów, logi inferencji, konfiguracje scenariuszy, pliki ewaluacyjne, metryki lokalności interwencji i zestawienie przypadków niepowodzeń. Weryfikator może odtworzyć pomiar na wskazanej wersji modelu i danych. Opinia użytkownika jest dodatkowa; podstawą są dane techniczne.',
      impact: 'Nieosiągnięcie kamienia oznacza brak potwierdzenia, że prototyp zachowuje właściwości opracowane w części badawczej w warunkach zbliżonych do operacyjnych. Skutkiem jest konieczność ograniczenia zakresu wdrożenia, powtórzenia integracji albo zmiany kryteriów akceptacji przed komercjalizacją.',
    },
  ],
};

export const indicators92 = [
  {
    name: 'Liczba wdrożonych wyników prac B+R',
    methodology: 'Wskaźnik liczy wyłącznie wdrożenia wyników B+R projektu RNM, czyli użycie rodziny modeli RNM, biblioteki interwencji lub katalogu konceptów w środowisku produkcyjnym, komercyjnym albo wewnętrznym Wisent Polska na terytorium UE. Do licznika trafia tylko wdrożenie powiązane z konkretną wersją modelu, manifestem artefaktów, datą uruchomienia, zakresem funkcji oraz dowodem wykorzystania. Nie wlicza się demonstracji, testów jednorazowych, samych repozytoriów ani materiałów promocyjnych. Wartość bazowa 0 wynika z braku wdrożeń RNM przed projektem.',
    verification: 'Weryfikacja opiera się na rejestrze wdrożeń RNM zawierającym identyfikator wdrożenia, wersję modelu, hash artefaktów, zakres funkcji, datę uruchomienia i podmiot korzystający. Dowodami są protokół uruchomienia, umowa licencyjna lub wdrożeniowa, faktura albo wewnętrzny protokół produkcyjnego użycia, logi dostępowe i manifest techniczny. Weryfikator sprawdza, czy wdrożenie dotyczy wyników B+R, a nie zwykłej publikacji kodu.',
  },
  {
    name: 'Liczba wprowadzonych innowacji produktowych',
    methodology: 'Wskaźnik liczy jedną innowację produktową: rodzinę modeli RNM z katalogiem konceptów, biblioteką interwencji i mechanizmem audytu reprezentacyjnego. Innowacja jest liczona po spełnieniu trzech warunków: istnieje wersjonowany artefakt produktu, opisane są funkcje odróżniające RNM od modeli referencyjnych, a produkt jest udostępniony użytkownikom lub klientom na rynku UE. Benchmarki są danymi pomocniczymi; podstawą wyliczenia jest fakt wprowadzenia produktu o nowych funkcjach.',
    verification: 'Weryfikator porównuje kartę produktu RNM, manifest modeli, dokumentację funkcji reprezentacyjnych, repozytorium biblioteki i dowody udostępnienia produktu. Sprawdza, czy produkt obejmuje sterowanie konceptami, ślad audytowy i integrację z modelem RNM, a nie tylko usługę konsultingową albo standardowy transformer. Dodatkowymi dowodami są umowy licencyjne, faktury, data publikacji artefaktów i lista funkcji dostępnych w wydaniu.',
  },
  {
    name: 'Liczba wprowadzonych innowacji procesowych',
    methodology: 'Wskaźnik pozostaje równy 0, ponieważ projekt deklaruje innowację produktową, a nie procesową. Wyliczenie polega na sprawdzeniu, czy w dokumentacji projektu nie wskazano odrębnej zmiany procesu produkcji, logistyki, zarządzania jakością, dostaw, obsługi klienta lub organizacji pracy jako rezultatu dofinansowanego projektu. Prace nad pipeline treningowym i walidacyjnym są środkiem B+R prowadzącym do produktu RNM, nie samodzielną innowacją procesową.',
    verification: 'Weryfikacja polega na przeglądzie klasyfikacji innowacji w sekcji 2.2, rejestru rezultatów projektu oraz opisów wdrożenia. Wartość 0 jest potwierdzona, jeżeli jedynym rezultatem rynkowym jest produkt RNM, a dokumentacja nie zawiera odrębnego wdrożenia procesu wewnętrznego jako innowacji. Dowodem jest rejestr innowacji podpisany przez spółkę i zestawienie rezultatów bez pozycji procesowej.',
  },
  {
    name: 'Przedsiębiorstwa wprowadzające innowacje produktowe lub procesowe',
    methodology: 'Wskaźnik liczy przedsiębiorstwa, które wprowadziły innowację powstałą w projekcie. W tym projekcie licznikiem jest Wisent Polska jako beneficjent wdrażający innowację produktową RNM. Nie dolicza się klientów testowych ani podmiotów uczestniczących w walidacji technicznej, jeżeli nie wprowadzają u siebie innowacji jako własnego produktu lub procesu. Wartość 1 oznacza jedno przedsiębiorstwo wdrażające produkt RNM.',
    verification: 'Weryfikacja obejmuje rejestr innowacji Wisent Polska, dokument wdrożenia produktu RNM, dokumenty rejestrowe spółki i dowód udostępnienia produktu na rynku UE. Sprawdza się, czy beneficjent faktycznie wprowadził innowację produktową, a nie tylko zakończył prace badawcze. Dowodami są manifest produktu, data wydania, umowa lub faktura oraz zapis decyzji o wprowadzeniu produktu.',
  },
  {
    name: 'Przedsiębiorstwa wprowadzające innowacje produktowe',
    methodology: 'Wskaźnik liczy przedsiębiorstwa wprowadzające innowację produktową. Wartość docelowa 1 obejmuje Wisent Polska, ponieważ rezultatem projektu jest produkt RNM, a nie sama metoda badawcza. Warunkiem zaliczenia jest dostępny artefakt produktu: wersja modeli, biblioteka, katalog konceptów i funkcje audytu/interwencji. Klienci i partnerzy walidacyjni nie są liczeni, chyba że odrębnie wprowadzą własną innowację.',
    verification: 'Weryfikator sprawdza zestaw artefaktów produktu RNM: wersjonowane modele, bibliotekę, katalog konceptów, opis funkcji, datę udostępnienia i dokument sprzedażowy lub licencyjny. Wartość 1 jest uznana, gdy Wisent Polska wprowadziła produkt na rynek UE lub do własnej działalności gospodarczej w sposób udokumentowany. Same wyniki benchmarków i publikacje naukowe nie wystarczają.',
  },
  {
    name: 'Przedsiębiorstwa wprowadzające innowacje procesowe',
    methodology: 'Wartość docelowa wynosi 0, ponieważ projekt nie przewiduje wprowadzenia innowacji procesowej jako rezultatu. Wyliczenie jest negatywne: sprawdza się, czy żadne przedsiębiorstwo, w tym Wisent Polska, nie deklaruje w ramach projektu nowego procesu produkcji, logistyki, zarządzania lub dostarczania usług jako osobnej innowacji. Zmiany narzędziowe potrzebne do wytworzenia RNM nie są liczone jako wdrożony proces.',
    verification: 'Weryfikacja polega na przeglądzie rejestru innowacji, dokumentów wdrożeniowych i ewidencji rezultatów. Wartość 0 jest potwierdzona, jeżeli dokumenty wskazują wyłącznie innowację produktową i brak odrębnych procesów wdrożonych jako rezultat projektu. Dowodami są klasyfikacja z sekcji 2.2, rejestr rezultatów i oświadczenie spółki o braku innowacji procesowej.',
  },
  {
    name: 'Małe i średnie przedsiębiorstwa (MŚP) wprowadzające innowacje produktowe lub procesowe',
    methodology: 'Wskaźnik liczy MŚP, które wprowadziły innowację produktową lub procesową. W projekcie liczy się Wisent Polska, jeżeli na dzień rozliczenia zachowuje status MŚP i wprowadza produkt RNM. Metodologia łączy dwie weryfikacje: status przedsiębiorstwa według definicji MŚP oraz fakt wprowadzenia innowacji produktowej. Nie liczy się partnerów, dostawców compute ani użytkowników testowych.',
    verification: 'Dowody obejmują dokumenty KRS, dane zatrudnienia i finansowe potrzebne do statusu MŚP, rejestr innowacji, manifest produktu RNM oraz dokument wdrożenia lub sprzedaży. Weryfikator sprawdza aktualność statusu MŚP oraz związek innowacji z wynikami projektu. Wartość 1 jest przyjęta tylko wtedy, gdy oba warunki są spełnione jednocześnie.',
  },
  {
    name: 'Małe i średnie przedsiębiorstwa (MŚP) wprowadzające innowacje procesowe',
    methodology: 'Wartość wskaźnika wynosi 0, ponieważ Wisent Polska jako MŚP nie wprowadza w projekcie innowacji procesowej. Wyliczenie polega na sprawdzeniu braku procesowego rezultatu w dokumentacji oraz potwierdzeniu, że wszystkie prace nad pipeline, walidacją i integracją służą opracowaniu produktu RNM. Nie tworzy się osobnego procesu biznesowego jako rezultatu wskaźnikowego.',
    verification: 'Weryfikacja wykorzystuje rejestr rezultatów, sekcję 2.2, dokumenty wdrożeniowe oraz oświadczenie spółki. Wartość 0 jest potwierdzona, gdy dokumenty nie wskazują żadnej procesowej innowacji MŚP, a jedyny rezultat to produkt RNM. Kontrola statusu MŚP jest pomocnicza i nie zmienia wartości, ponieważ liczba procesowych innowacji pozostaje zerowa.',
  },
  {
    name: 'Małe i średnie przedsiębiorstwa (MŚP) wprowadzające innowacje produktowe',
    methodology: 'Wskaźnik liczy MŚP, które wprowadziły innowację produktową. Wartość 1 oznacza Wisent Polska jako MŚP wprowadzające produkt RNM. Zaliczenie wymaga jednocześnie potwierdzenia statusu MŚP oraz udostępnienia produktu obejmującego modele RNM, bibliotekę, katalog konceptów i funkcje audytu/interwencji. Wartość nie obejmuje podmiotów korzystających z produktu ani dostawców infrastruktury.',
    verification: 'Weryfikator sprawdza dokumenty statusu MŚP, rejestr innowacji, manifest modeli RNM, repozytorium biblioteki, datę wydania i dowód udostępnienia produktu na rynku UE. Źródłami są KRS, dane finansowe i zatrudnieniowe, karta produktu, umowa licencyjna lub faktura. Wartość 1 jest uznana wyłącznie po potwierdzeniu obu elementów: statusu MŚP i faktycznego wprowadzenia innowacji produktowej.',
  },
];

export const management41 = [
  'Projekt jest zarządzany dwutorowo: odpowiedzialność merytoryczna za prace B+R jest oddzielona od odpowiedzialności finansowo-operacyjnej. Linh Le odpowiada za nadzór merytoryczny nad kierunkiem badań i zgodnością eksperymentów z hipotezami projektu. Łukasz Bartoszcze jako Senior Machine Learning Engineer odpowiada za architekturę eksperymentów, implementację prototypów RNM, analizę wyników i decyzje techniczne dotyczące stosu treningowego. Łukasz Szpruch wspiera przegląd naukowy i metodologiczny. Weronika Pernak odpowiada za zarządzanie operacyjne, budżet, kwalifikowalność wydatków i sprawozdawczość, a Zuzanna Bartoszcze wspiera organizację dokumentacji.',
  'Decyzje techniczne zapadają w tygodniowym cyklu przeglądu architektury. Omawiane są wyniki eksperymentów, zużycie mocy obliczeniowej, stabilność kierunków konceptów, jakość generacji i ryzyka B+R. Decyzje finansowe i operacyjne zapadają w miesięcznym cyklu przeglądu budżetu na podstawie kosztów w kategoriach FENG, postępu zadań, wykorzystania GPU i statusu kamieni milowych. Taki podział zapobiega mieszaniu prac badawczych z administracją projektu.',
  'Każdy eksperyment B+R ma przypisany budżet obliczeniowy z ustalonym pułapem egzekwowanym w stosie treningu. Ryzyka są rejestrowane i przeglądane cyklicznie; decyzje przekraczające ustalony próg wartości lub terminów wymagają akceptacji osoby odpowiedzialnej za nadzór merytoryczny B+R oraz osoby odpowiedzialnej za zarządzanie projektem. Zarządzanie wykorzystuje Git, rejestr eksperymentów, checklisty kamieni milowych, repozytorium artefaktów i ewidencję kosztów.',
  'Metodyka łączy iteracyjny rozwój badawczy z kontrolą finansową. Pozwala szybko korygować nieudane hipotezy, zachować pełną ścieżkę decyzyjną i utrzymać rozdział między kosztami B+R a kosztami pośrednimi. Wspiera to budowę niezależnych możliwości AI w UE oraz ograniczanie strategicznej zależności od zagranicznych dostawców modeli generatywnych.',
].join('\n\n');
