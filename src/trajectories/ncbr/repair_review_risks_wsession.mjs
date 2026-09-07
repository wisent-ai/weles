// Targeted review-risk repair for the replacement NCBR STEP B draft.
// Edits only 6.1 task 5 and selected 9.2 indicator descriptions. Never submits.

import { WSession } from '../../../dist/index.js';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';
import { humanFill } from '../../../dist/human/keyboard.js';

const PROJECT_ID = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const PROJECT_URL = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}`;
const BASE = `${PROJECT_URL}/projekt_step/`;
const URL_41 = `${BASE}5af236aa-03b2-4650-b5a2-95c299dfeeaf`;
const URL_61 = `${BASE}566c735c-8ad0-406f-a948-f3ea921c2cc7`;
const URL_92 = `${BASE}e95d0c23-8a39-4d56-96fa-ace3e4f0d23a`;
const email = process.env.NCBR_EMAIL;
const password = process.env.NCBR_PASSWORD;

if (!email || !password) {
  console.log(JSON.stringify({ error: 'MISSING_NCBR_CREDENTIALS' }, null, 2));
  process.exit(2);
}
delete process.env.NCBR_PASSWORD;

const task5 = {
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

const indicators92 = [
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

const management41 = [
  'Projekt jest zarządzany dwutorowo: odpowiedzialność merytoryczna za prace B+R jest oddzielona od odpowiedzialności finansowo-operacyjnej. Linh Le odpowiada za nadzór merytoryczny nad kierunkiem badań i zgodnością eksperymentów z hipotezami projektu. Łukasz Bartoszcze jako Senior Machine Learning Engineer odpowiada za architekturę eksperymentów, implementację prototypów RNM, analizę wyników i decyzje techniczne dotyczące stosu treningowego. Łukasz Szpruch wspiera przegląd naukowy i metodologiczny. Weronika Pernak odpowiada za zarządzanie operacyjne, budżet, kwalifikowalność wydatków i sprawozdawczość, a Zuzanna Bartoszcze wspiera organizację dokumentacji.',
  'Decyzje techniczne zapadają w tygodniowym cyklu przeglądu architektury. Omawiane są wyniki eksperymentów, zużycie mocy obliczeniowej, stabilność kierunków konceptów, jakość generacji i ryzyka B+R. Decyzje finansowe i operacyjne zapadają w miesięcznym cyklu przeglądu budżetu na podstawie kosztów w kategoriach FENG, postępu zadań, wykorzystania GPU i statusu kamieni milowych. Taki podział zapobiega mieszaniu prac badawczych z administracją projektu.',
  'Każdy eksperyment B+R ma przypisany budżet obliczeniowy z ustalonym pułapem egzekwowanym w stosie treningu. Ryzyka są rejestrowane i przeglądane cyklicznie; decyzje przekraczające ustalony próg wartości lub terminów wymagają akceptacji osoby odpowiedzialnej za nadzór merytoryczny B+R oraz osoby odpowiedzialnej za zarządzanie projektem. Zarządzanie wykorzystuje Git, rejestr eksperymentów, checklisty kamieni milowych, repozytorium artefaktów i ewidencję kosztów.',
  'Metodyka łączy iteracyjny rozwój badawczy z kontrolą finansową. Pozwala szybko korygować nieudane hipotezy, zachować pełną ścieżkę decyzyjną i utrzymać rozdział między kosztami B+R a kosztami pośrednimi. Wspiera to budowę niezależnych możliwości AI w UE oraz ograniczanie strategicznej zależności od zagranicznych dostawców modeli generatywnych.',
].join('\n\n');

const session = await WSession.start({ label: 'ncbr_review_risk_repair_wsession', proxy: 'direct', browser: 'chromium' });
const page = session.page;
page.setDefaultTimeout(30000);

async function setReactInputValue(locator, value) {
  await locator.waitFor({ state: 'visible' });
  await humanClickLocator(page, locator);
  const locked = await locator.evaluate((el) => Boolean(el.readOnly || el.disabled)); // allow-raw-playwright: inspect controlled field mutability
  if (!locked) {
    await humanFill(page, locator, '');
    await humanFill(page, locator, value)
  }
  await humanIdlePause('short');
}

async function login() {
  await page.goto('https://lsi2.ncbr.gov.pl/logowanie', { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: LSI login navigation
  await humanIdlePause('long');
  await setReactInputValue(page.locator('#mail, input[name="mail"]').first(), email);
  await setReactInputValue(page.locator('#password, input[name="password"]').first(), password);
  const statute = page.locator('label:has(#isStatuteAccepted), label:has(input[name="isStatuteAccepted"]), #isStatuteAccepted, input[name="isStatuteAccepted"]:visible').first();
  if (await statute.count() && !await page.locator('#isStatuteAccepted, input[name="isStatuteAccepted"]').first().isChecked()) await humanClickLocator(page, statute);
  await humanIdlePause('short');
  await page.waitForFunction(() => {
    const btn = document.querySelector('#login-btn') || Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Zaloguj');
    return !!btn && !btn.disabled;
  }, null, { timeout: 10000 }).catch(() => null); // allow-raw-playwright: wait for login validation
  await humanClickLocator(page, page.locator('#login-btn, button:has-text("Zaloguj")').first());
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
  await humanIdlePause('long');
  if (page.url().includes('/logowanie')) throw new Error('login stayed on login page');
}

async function saveVisibleForm() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  const saves = page.getByRole('button', { name: 'Zapisz', exact: true }).filter({ visible: true });
  const saveCount = await saves.count();
  if (!saveCount) throw new Error('no enabled visible Zapisz');
  await humanClickLocator(page, saves.nth(saveCount - 1));
  await humanIdlePause('long');
}

async function fillByName(name, value) {
  const visible = page.locator(`[name="${name}"]:visible`);
  const loc = (await visible.count() > 0) ? visible.last() : page.locator(`[name="${name}"]`).last();
  await loc.waitFor({ state: 'visible' });
  const max = Number(await loc.getAttribute('maxlength')) || String(value || '').length;
  let next = String(value || '');
  if (next.length > max) next = next.slice(0, max).replace(/\s+\S*$/, '');
  await setReactInputValue(loc, next);
  return { name, len: next.length, max };
}

async function fillBySuffix(suffix, value) {
  const visible = page.locator(`[name$="${suffix}"]:visible`);
  const loc = (await visible.count() > 0) ? visible.last() : page.locator(`[name$="${suffix}"]`).last();
  await loc.waitFor({ state: 'visible' });
  const max = Number(await loc.getAttribute('maxlength')) || String(value || '').length;
  let next = String(value || '');
  if (next.length > max) next = next.slice(0, max).replace(/\s+\S*$/, '');
  await setReactInputValue(loc, next);
  return { suffix, len: next.length, max };
}

async function openTask61(nr) {
  await page.goto(URL_61, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 6.1 navigation
  await humanIdlePause('long');
  const row = page.locator('table tbody tr').filter({ has: page.locator(`td[title^="${nr}. " ]`) }).first();
  const btn = row.locator('button[aria-label="overflow-options"]').first();
  if (!await btn.count()) throw new Error(`task row menu not found: ${nr}`);
  await humanClickLocator(page, btn);
  await humanIdlePause('deliberate');
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit existing task row
  await humanIdlePause('long');
  await page.waitForSelector('[name="nazwa_zadania"]');
}

async function repairTask5() {
  console.log('[6.1] repair task 5');
  await openTask61('5');
  const filled = [];
  filled.push(await fillByName('nazwa_zadania', task5.name));
  filled.push(await fillByName('zakres_planowanych_prac_br', task5.scope));
  filled.push(await fillByName('szczegolowy_opis_prac', task5.detail));

  const indexes = await page.evaluate(() => [...new Set(Array.from(document.querySelectorAll('textarea[name^="kamienie_milowe_kolekcja["]'))
    .map((el) => Number((el.name.match(/kamienie_milowe_kolekcja\[(\d+)\]/) || [])[1]))
    .filter((n) => Number.isInteger(n)))].sort((a, b) => a - b)); // allow-raw-playwright: read nested milestone indexes
  for (const idx of indexes.slice(0, task5.milestones.length)) {
    const m = task5.milestones[idx];
    filled.push(await fillByName(`kamienie_milowe_kolekcja[${idx}].kamienie_milowe_nazwa`, m.name));
    filled.push(await fillByName(`kamienie_milowe_kolekcja[${idx}].kamienie_milowe_parametry`, m.params));
    filled.push(await fillByName(`kamienie_milowe_kolekcja[${idx}].kamienie_milowe_opis_weryfikacji`, m.verify));
    filled.push(await fillByName(`kamienie_milowe_kolekcja[${idx}].kamienie_milowe_opis_wplywu`, m.impact));
  }
  await saveVisibleForm();
  return filled;
}

async function openIndicator92(name) {
  await page.goto(URL_92, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 9.2 navigation
  await humanIdlePause('long');
  const row = page.locator('table tbody tr').filter({ hasText: name }).first();
  const btn = row.locator('button[aria-label="overflow-options"]').first();
  if (!await btn.count()) throw new Error(`indicator row menu not found: ${name}`);
  await humanClickLocator(page, btn);
  await humanIdlePause('deliberate');
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit existing indicator row
  await humanIdlePause('long');
  await page.waitForSelector('textarea[name$="opis_metodologii"], textarea[name$="opis_sposobu_weryfikacji"]');
}

async function repairIndicators92() {
  const results = [];
  for (const ind of indicators92) {
    console.log(`[9.2] ${ind.name}`);
    await openIndicator92(ind.name);
    const filled = [];
    filled.push(await fillBySuffix('opis_metodologii', ind.methodology));
    filled.push(await fillBySuffix('opis_sposobu_weryfikacji', ind.verification));
    await saveVisibleForm();
    results.push({ name: ind.name, filled });
  }
  return results;
}

async function repairManagement41() {
  console.log('[4.1] repair management text');
  await page.goto(URL_41, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 4.1 navigation
  await humanIdlePause('long');
  const filled = await fillBySuffix('sposob_zarzadzania_projektem', management41);
  await saveVisibleForm();
  return filled;
}

async function readManagement41() {
  await page.goto(URL_41, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 4.1 read-only navigation
  await humanIdlePause('long');
  return await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('textarea, input')).find((field) => (field.name || '').endsWith('sposob_zarzadzania_projektem'));
    const value = el?.value || '';
    return {
      url: location.href,
      len: value.length,
      hasKierownikBR: /Kierownik B\+R/i.test(value),
      hasLimitWord: /\blimit|\blimitem|\blimitu/i.test(value),
      suffix: value.slice(-320),
    };
  }); // allow-raw-playwright: read one section 4.1 textarea only
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
  const validateButton = page.getByRole('button', { name: 'Sprawdź wniosek', exact: true }).filter({ visible: true }).first();
  const clicked = await validateButton.count() && !await validateButton.isDisabled()
    ? await humanClickLocator(page, validateButton).then(() => ({ clicked: true }))
    : { clicked: false, reason: 'enabled Sprawdz wniosek button not found' };
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

async function readbackSnippets() {
  const out = {};
  await page.goto(URL_61, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 6.1 readback
  await humanIdlePause('long');
  out.task61 = await page.evaluate(() => document.querySelector('table')?.innerText.replace(/\s+/g, ' ').trim() || ''); // allow-raw-playwright: read 6.1 table text
  await page.goto(URL_92, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 9.2 readback
  await humanIdlePause('long');
  out.indicators92 = await page.evaluate(() => document.querySelector('table')?.innerText.replace(/\s+/g, ' ').trim() || ''); // allow-raw-playwright: read 9.2 table text
  return out;
}

await login();
if (process.env.REPAIR_41_ONLY === '1') {
  const repaired41 = await repairManagement41();
  const validation = await validateProject();
  console.log(JSON.stringify({ repaired41, validation }, null, 2));
  await session.ctx.close();
  process.exit(0);
}
if (process.env.READ_41_ONLY === '1') {
  const management = await readManagement41();
  console.log(JSON.stringify({ management }, null, 2));
  await session.ctx.close();
  process.exit(0);
}
const repairedTask5 = await repairTask5();
const repairedIndicators92 = await repairIndicators92();
const validation = await validateProject();
const snippets = await readbackSnippets();

console.log(JSON.stringify({
  repairedTask5,
  repairedIndicators92: repairedIndicators92.map((r) => ({ name: r.name, filled: r.filled })),
  validation,
  readback: {
    task5Present: snippets.task61.includes(task5.name),
    routineRiskGone: !/Publikacja czterech modeli RNM 1B-70B w formacie HuggingFace transformers z model card/i.test(snippets.task61),
    repeatedBaselineCount: (snippets.indicators92.match(/Wartość bazowa wynosi 0, ponieważ/g) || []).length,
    reportPhraseCount: (snippets.indicators92.match(/raport końcowy/g) || []).length,
  },
}, null, 2));

await session.ctx.close();
process.exit(0);
