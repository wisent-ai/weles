// The budget rows: the direct and indirect cost rows of 6.3 and 6.5, and the section 8
// financing fields.

export const DIRECT_ROWS = [
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

export const INDIRECT_ROWS = [
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

export const FINANCING_8 = {
  'srodki_wlasne': '0.00',
  'środki własne': '0.00',
  'pozycz': '3675000.00',
  'pożycz': '3675000.00',
  'prywatne': '3675000.00',
  'kredyt': '0.00',
  'inne': '0.00',
};
