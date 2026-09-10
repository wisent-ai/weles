// The budget rows repair_budget_wsession.mjs writes: the direct and indirect cost
// rows, the obsolete rows it deletes, the required-field repairs and the section 8 financing.

export const DIRECT_ROWS = [
  {
    match: /1\s*049\s*000,00\s*zł/i,
    name: 'Senior Machine Learning Engineer RNM (1,0 FTE, 36 mies.)',
    total: '1049000.00',
    grant: '839200.00',
    uz: 'Koszt obejmuje wyłącznie techniczne prace B+R wykonywane przez Senior Machine Learning Engineera: projekt funkcji celu RNM, implementację prototypów treningowych, eksperymenty reprezentacyjne, analizę wyników, debugowanie modeli i dokumentację badawczą. Nie obejmuje kierowania projektem, koordynacji administracyjnej, raportowania finansowego, sprzedaży ani czynności właścicielskich; takie czynności są pokrywane kosztami pośrednimi.',
    met: 'Kalkulacja: 1,0 FTE x 36 miesięcy x pełny miesięczny koszt pracodawcy dla senior/principal ML engineer w projekcie AI. Stawkę oszacowano na podstawie rynkowych widełek wynagrodzeń AI/ML w UE i Polsce, poziomu seniority oraz odpowiedzialności za architekturę eksperymentalnych modeli RNM.',
  },
  {
    match: /4\s*251\s*000,00\s*zł/i,
    name: 'Pozostały personel B+R - badania przemysłowe (4,25 FTE, 36 mies.)',
    total: '4251000.00',
    grant: '3400800.00',
    uz: 'Koszt obejmuje stanowiska badawcze i inżynierskie w zadaniach badań przemysłowych: ML Research Scientist, Research Engineer, Data/Evaluation Scientist oraz MLOps Experiment Engineer. Zakres obejmuje projekt eksperymentów, trening modeli, ekstrakcję konceptów, ewaluację i analizę wyników. Nie obejmuje zarządzania administracyjnego, marketingu, sprzedaży ani utrzymania komercyjnego.',
    met: 'Kalkulacja: 4,25 FTE x 36 miesięcy x średni pełny koszt pracodawcy dla ról ML/R&D. Stawki dobrano według poziomów seniority, stawek rynkowych AI/ML i udziału czasu w zadaniach badawczych. Koszty przypisano proporcjonalnie do zadań badań przemysłowych.',
  },
  {
    match: /(3\s*000\s*000,00|4\s*700\s*000,00)\s*zł/i,
    name: 'Wynajem mocy GPU do treningu i ewaluacji RNM w zadaniach BP',
    total: '4700000.00',
    grant: '3760000.00',
    uz: 'Koszt obejmuje wynajem mocy GPU w UE do treningu RNM 1B/8B/30B/70B, treningu modeli referencyjnych, checkpointów, pomiaru krzywych uczenia i benchmarków w zadaniach badań przemysłowych. Compute jest używany wyłącznie do eksperymentów B+R, nie do produkcyjnej obsługi klientów ani bieżącej działalności operacyjnej.',
    met: 'Szacunek obejmuje pełne cykle treningowe RNM 1B/8B/30B/70B, modele referencyjne, checkpointy, powtórzenia eksperymentów, walidację porównawczą i przechowywanie artefaktów. Kalkulacja odpowiada ok. 750 tys. godzin GPU w ekwiwalencie H100/B300/A100/L40S oraz cenom ofertowym europejskich dostawców infrastruktury GPU.',
  },
  {
    match: /(2\s*200\s*000,00|2\s*500\s*000,00)\s*zł/i,
    name: 'Personel B+R - prace rozwojowe: integracja modeli RNM, biblioteka i dokumentacja (2,45 FTE)',
    total: '2500000.00',
    grant: '1500000.00',
    uz: 'Koszt obejmuje wyłącznie wynagrodzenia personelu B+R wykonującego prace rozwojowe w Zadaniu 5: integrację wyników badań w działającą bibliotekę RNM, przygotowanie narzędzi API, uporządkowanie katalogu konceptów, testy techniczne implementacji, poprawki kodu oraz dokumentację techniczną. Nie obejmuje zewnętrznych pilotaży, publikacji, marketingu, compliance, obsługi klienta ani utrzymania komercyjnego.',
    met: 'Kalkulacja: 2,45 FTE w okresie prac rozwojowych x pełny koszt pracodawcy ról ML Engineer, Software Engineer i Evaluation Engineer. Stawki oszacowano na podstawie widełek wynagrodzeń AI/software w UE i Polsce, wymaganego seniority oraz udziału tych osób w Zadaniu 5.',
  },
];

export const OBSOLETE_ROWS = [
  'Licencje oprogramowania',
  'Ekspertyzy IP/AI Act',
  'Koszty walidacji PR',
];

export const INDIRECT_ROWS = [
  {
    match: 'Pomoc na badania przemysłowe',
    total: '1325000.00',
    grant: '1060000.00',
    info: '25%',
    uz: 'Koszty pośrednie obejmują administrację, księgowość, HR, obsługę prawną, IT support, utrzymanie siedziby i zarządzanie projektem w części przypisanej do badań przemysłowych. Wybrano metodę uproszczoną - stawkę ryczałtową 25% kwalifikowalnych kosztów bezpośrednich objętych podstawą naliczenia kosztów pośrednich.',
  },
  {
    match: 'Pomoc na prace rozwojowe',
    total: '625000.00',
    grant: '375000.00',
    info: '25%',
    uz: 'Koszty pośrednie obejmują administrację, księgowość, HR, obsługę prawną, IT support, utrzymanie siedziby i zarządzanie projektem w części przypisanej do prac rozwojowych. Wybrano metodę uproszczoną - stawkę ryczałtową 25% kosztów kwalifikowalnych prac rozwojowych.',
  },
];

export const FIELD_REPAIRS_63 = [
  {
    match: /1\s*049\s*000,00\s*zł/i,
    name: 'Senior Machine Learning Engineer RNM (1,0 FTE, 36 mies.)',
    uz: DIRECT_ROWS[0].uz,
    met: DIRECT_ROWS[0].met,
  },
  {
    match: /4\s*251\s*000,00\s*zł/i,
    name: 'Pozostały personel B+R - badania przemysłowe (4,25 FTE, 36 mies.)',
    uz: DIRECT_ROWS[1].uz,
    met: DIRECT_ROWS[1].met,
  },
  {
    match: /(3\s*000\s*000,00|4\s*700\s*000,00)\s*zł/i,
    name: 'Wynajem mocy GPU do treningu i ewaluacji RNM w zadaniach BP',
    uz: DIRECT_ROWS[2].uz,
    met: DIRECT_ROWS[2].met,
  },
  {
    match: /(2\s*200\s*000,00|2\s*500\s*000,00)\s*zł/i,
    name: 'Personel B+R - prace rozwojowe: integracja modeli RNM, biblioteka i dokumentacja (2,45 FTE)',
    uz: DIRECT_ROWS[3].uz,
    met: DIRECT_ROWS[3].met,
  },
];

export const FINANCING_8 = {
  total: '14450000.00',
  grant: '10935000.00',
  private: '3515000.00',
  own: '0.00',
  loan: '3515000.00',
};
