import { readFileSync, writeFileSync } from 'node:fs';

const SRC = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_2.3_rynek_i_potencjal.md';
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const EXTRA = {
  'Mistral benefit': [
    'To mierzy przewagę architektury, nie sam branding dostawcy.',
  ],
  'Aleph product': [
    'Punkt rynku UE.',
  ],
  'Aleph funkcje': [
    'Bez RNM.',
  ],
  'Aleph benefit': [
    'W praktyce audytu różnica polega na tym, że RNM pozwalają powiązać zmianę zachowania z nazwanym kierunkiem i wersją katalogu, a nie tylko z opisem odpowiedzi lub polityką systemową. To daje lepszy materiał dla dokumentacji nadzoru człowieka.',
    'To dowód kontroli modelu.',
  ],
  'H benefit': [
    'Dla systemów agentowych oznacza to również niższe ryzyko eskalacji błędu: przed wykonaniem narzędzia można monitorować koncepty odpowiedzialne za odmowę, niepewność, halucynację lub działanie poza zakresem uprawnień.',
  ],
  'H product': [
    'Agenci.',
  ],
  'LightOn benefit': [
    'Dzięki temu RNM mogą stać się komponentem dla wielu platform wdrożeniowych, zamiast jedną aplikacją końcową. Przewaga rynkowa polega na sprzedawalnym module bazowym: modelu, katalogu konceptów i dokumentacji audytowej gotowej do integracji.',
  ],
  'Synerise benefit': [
    'Wariant RNM ma więc potencjał komplementarny wobec istniejących platform analitycznych: dostarcza generatywny komponent kontrolowany od wewnątrz, który można podłączyć do procesów decyzyjnych wymagających uzasadnienia i śladu technicznego.',
  ],
  'GPT benefit': [
    'Dodatkowo RNM pozwalają przenieść część kompetencji z poziomu dostępu do API na poziom własnej technologii: zespół klienta lub integratora może weryfikować wersję modelu, katalog konceptów, parametry interwencji i wynik ewaluacji bez oczekiwania na ujawnienia dostawcy spoza UE.',
  ],
  'Anthropic benefit': [
    'Dla klienta europejskiego istotne jest też to, że reguły bezpieczeństwa mogą stać się mierzalnym obiektem technicznym: konceptem, którego aktywację, stabilność i wpływ na odpowiedź można testować, a nie wyłącznie polityką opisaną przez operatora API.',
  ],
  'Google benefit': [
    'RNM odpowiadają na tę lukę przez oddzielenie wartości modelu od globalnego ekosystemu chmurowego. Klient może integrować model z własnymi systemami, zachowując dowody dla kontroli: wersję wag, wersję katalogu, raport aktywacji i parametry interwencji.',
  ],
  'Meta benefit': [
    'W RNM elementem przewagi jest procedura utrzymania kontroli po wdrożeniu: aktualizacja katalogu konceptów, test stabilności po zmianie modelu oraz raport, który pozwala sprawdzić, czy interwencja poprawia wybraną własność bez degradacji pozostałych kompetencji.',
  ],
  'Qwen benefit': [
    'Wymiar strategiczny jest tutaj szczególnie istotny: RNM nie tylko używają modelu w Europie, ale budują europejską zdolność trenowania, walidowania i kontrolowania architektury. To ogranicza zależność od pozaunijnych licencji, priorytetów językowych i decyzji produktowych.',
  ],
  'DeepSeek benefit': [
    'Dlatego w porównaniu nie wystarczy mierzyć kosztu. RNM muszą pokazać, że efektywność obliczeniowa idzie razem z audytowalnością: mniej tokenów, niższy koszt inferencji, stabilne koncepty i mierzalna lokalność interwencji tworzą jedną przewagę produktu.',
  ],
  'Goodfire benefit': [
    'To rozróżnienie odpowiada bezpośrednio na feedback NCBR: reprezentacje istnieją, ale projektem B+R jest stworzenie modelu, w którym reprezentacje są projektowane, mierzone i używane operacyjnie jako powierzchnia sterowania, a nie tylko wykrywane po treningu.',
  ],
  'Transluce benefit': [
    'Dla klienta oznacza to krótszą pętlę zarządzania ryzykiem. Obserwacja, diagnoza i korekta nie są trzema osobnymi produktami, lecz częściami jednego przepływu: wykryty koncept może zostać opisany, zmierzony, ograniczony i udokumentowany w raporcie inferencji.',
  ],
  'Gray benefit': [
    'Przewaga RNM nie polega więc na rezygnacji z red-teamu, lecz na tym, że wynik red-teamu może zasilić katalog konceptów i stać się kontrolowaną interwencją. To zamienia test bezpieczeństwa w trwałą funkcję modelu, a nie jednorazową listę podatności.',
  ],
  'p1 name': ['Wymagany jest aktywny płatny dostęp do RNM.'],
  'p2 name': ['Przychód musi być udokumentowany fakturą za RNM.'],
  'p3 name': ['Kwalifikacja klienta i płatność muszą być możliwe do kontroli.'],
  'p4 name': ['Kwota musi być przypisana do modelu, katalogu konceptów lub API RNM.'],
  'p5 name': ['Sumowanie obejmuje tylko lata komercjalizacji RNM w UE.'],
  'p6 name': ['Wartość pokazuje transgraniczny efekt sprzedaży na rynku UE.'],
  'p7 name': ['Każde państwo wymaga aktywnego płatnego klienta RNM oraz dokumentu sprzedaży z krajem siedziby kontrahenta. Deduplikacja grup kapitałowych i oddziałów wyłącza sztuczne zawyżenie zasięgu geograficznego.'],
  'p8 name': ['Odbiorca musi być organizacją, nie anonimowym pobraniem; źródło użycia powinno wskazywać konto firmowe, klucz API, wdrożenie, umowę, fakturę albo zweryfikowany kontakt techniczny.'],
  'p9 name': ['EPC liczone jest proporcjonalnie do pracy przy RNM, z rozdzieleniem sprzedaży, wsparcia wdrożeń, utrzymania modeli, rozwoju katalogu konceptów i obsługi klientów regulowanych.'],
  'p10 name': ['Projekt musi mieć realny zakres B+R+I po RNM: osobny cel techniczny, hipotezę, budżet, właściciela, harmonogram i wykorzystanie wyników projektu jako punktu startowego.'],
  'p1 method': ['Założenie jest spójne z priorytetem STEP, bo głównym rynkiem pozostaje UE, a eksport poza UE jest tylko dodatkowym sprawdzianem atrakcyjności produktu bazowego.'],
  'p2 method': ['Wskaźnik kontroluje, czy eksport nie zastępuje efektu europejskiego; dlatego jego udział pozostaje pomocniczy wobec przychodu na rynku UE.'],
  'p3 method': ['Parametr mierzy akceptację przez najbardziej wymagających klientów, a nie samą liczbę użytkowników; dlatego wymaga odpłatnego wdrożenia lub pilotażu.'],
  'p4 method': ['Tak liczony przychód pokazuje skalę powtarzalnej sprzedaży produktu, a nie jednorazowych usług projektowych lub finansowania publicznego.'],
  'p5 method': ['Narastająca suma ogranicza ryzyko przypadkowego wyniku jednego roku i pokazuje zdolność utrzymania sprzedaży po zakończeniu prac B+R oraz po pierwszym wdrożeniu RNM.'],
  'p6 method': ['Parametr odróżnia krajową sprzedaż od realnego efektu rynku wewnętrznego, czyli ekspansji do klientów z innych państw członkowskich.'],
  'p7 method': ['Próg sześciu państw wzmacnia dowód skalowalności, bo wymaga powtórzenia sprzedaży w różnych jurysdykcjach, językach i sektorach regulowanych.'],
  'p8 method': ['Wskaźnik sprawdza dyfuzję technologii poza największych klientów enterprise, czyli zdolność RNM do działania jako komponent dla europejskich integratorów.'],
  'p9 method': ['Szacunek zatrudnienia jest powiązany z przychodem, wsparciem klientów i utrzymaniem modeli, a nie z arbitralną liczbą stanowisk.'],
  'p10 method': ['Parametr pokazuje, że RNM tworzą platformę dalszej innowacji, a nie pojedynczy rezultat kończący aktywność B+R w dniu wdrożenia.'],
  'p1 verify': ['W arkuszu kontrolnym zostanie zapisana reguła deduplikacji, osoba zatwierdzająca oraz ścieżka od klienta do dokumentu sprzedaży. W razie audytu każda pozycja musi prowadzić do aktywnej relacji płatnej.'],
  'p2 verify': ['Raport będzie zawierał tabelę uzgodnienia: faktura, kontrahent, kraj, kurs waluty, kwota netto i część przypisana do RNM. Pozycje bez jednoznacznego opisu produktu zostaną wyłączone. Kurs i wyłączenia będą jawne.'],
  'p3 verify': ['Weryfikacja obejmie także kopię kryterium kwalifikacji do Fortune 500 Europe oraz datę sprawdzenia listy. Jeżeli klient zmieni status, liczy się status w roku docelowym. Grupy kapitałowe nie będą dublowane bez osobnej umowy.'],
  'p4 verify': ['Dodatkowym dowodem będzie mapa przychodów do modułów produktu: model, API, katalog konceptów, dokumentacja audytowa i wsparcie aktualizacji. Usługi poboczne będą wyodrębnione. Każda faktura musi mieć opis pozwalający przypisać ją do RNM.'],
  'p5 verify': ['Zestawienie narastające będzie przechowywać sumy roczne, korekty faktur i wyłączenia. Każda zmiana wartości po zamknięciu roku zostanie opisana notą księgową. Raport pokaże, które przychody powtarzają się z odnowień, a które pochodzą od nowych klientów.'],
  'p6 verify': ['Raport geograficzny będzie oddzielał Polskę, pozostałe państwa UE i kraje poza UE. Reguła kraju siedziby będzie stosowana konsekwentnie dla faktur i umów. Do każdej pozycji zostanie przypisany kontrahent, kraj, kwota netto, numer dokumentu i moduł RNM. Sprzedaż do Polski oraz eksport poza UE będą wykazane poza wskaźnikiem, aby nie zawyżyć efektu rynku wewnętrznego.'],
  'p7 verify': ['Dla każdego państwa zostanie wskazany co najmniej jeden klient, dokument płatności i zakres użycia RNM. Państwo bez płatnej relacji nie będzie liczone. Lista państw będzie oparta na kraju siedziby kontrahenta z umowy, nie na języku użytkownika ani lokalizacji serwera. Deduplikacja wykluczy wielokrotne liczenie tej samej grupy kapitałowej.'],
  'p8 verify': ['Lista odbiorców będzie zawierała identyfikator organizacji, domenę, kraj, rodzaj użycia, źródło aktywności i status płatny lub otwarty. Duplikaty będą usunięte. Dla kont API podstawą będzie billing lub aktywny klucz, dla modelu otwartego zgłoszenie wdrożenia, firmowy wkład w repozytorium albo potwierdzony kontakt techniczny. Anonimowe pobrania nie będą liczone.'],
  'p9 verify': ['Ewidencja EPC pokaże okres zatrudnienia, wymiar czasu pracy i procent przypisania do RNM. Role mieszane zostaną policzone proporcjonalnie, nie w całości. Dla każdej osoby zostanie zachowany zakres obowiązków, dokument zatrudnienia oraz uzasadnienie powiązania ze sprzedażą, wdrożeniem, utrzymaniem lub rozwojem RNM po zakończeniu projektu.'],
  'p10 verify': ['Każdy projekt zostanie opisany kartą celu, hipotezy, budżetu, właściciela i powiązania z RNM. Rutynowe wdrożenia i prace sprzedażowe będą wyłączone. Dowodem będzie decyzja o uruchomieniu projektu, harmonogram, repozytorium lub dokumentacja techniczna oraz opis, które wyniki RNM są użyte jako punkt wyjścia do nowych prac B+R+I.'],
};

function fit(label, text, max, min, clauses = []) {
  const parts = [text, ...clauses, ...(EXTRA[label] || [])].map(clean).filter(Boolean);
  const sentences = [];
  for (const part of parts) {
    const hits = part.match(/[^.!?]+[.!?]/g);
    if (hits) {
      sentences.push(...hits.map(clean).filter(Boolean));
      const consumed = hits.join('').length;
      const rest = clean(part.slice(consumed));
      if (rest) sentences.push(/[.!?]$/.test(rest) ? rest : `${rest}.`);
    } else {
      sentences.push(/[.!?]$/.test(part) ? part : `${part}.`);
    }
  }
  let out = '';
  for (const sentence of sentences) {
    const candidate = clean([out, sentence].filter(Boolean).join(' '));
    if (candidate.length <= max) {
      out = candidate;
    }
  }
  if (out.length < min || out.length > max) throw new Error(`${label}: ${out.length}/${max}, expected ${min}-${max}`);
  if (!/[.!?]$/.test(out)) throw new Error(`${label}: bad ending "${out.slice(-60)}"`);
  return out;
}

const EU = [
  {
    podmiot: 'Mistral AI',
    kraj: 'Francja',
    produkt: fit('Mistral product', 'Modele bazowe Mistral Large i otwarte wagi dla firm: klasyczne transformery, API, wdrożenia enterprise, narzędzia agentowe i oferta europejskiego dostawcy modeli ogólnego przeznaczenia.', 200, 190, ['Bez RNM.']),
    funkcjonalnosci: fit('Mistral funkcje', 'Generowanie i rozumowanie tekstowe, użycie przez API lub własne wdrożenia, integracje z narzędziami AI, wsparcie agentów, lecz kontrola zachowania oparta na instrukcjach, dostrojeniu i filtrach.', 200, 190, ['Bez RNM.']),
    korzysc: fit('Mistral benefit', 'Mistral jest najważniejszym europejskim punktem odniesienia dla modeli bazowych, ale jego oferta pozostaje klasycznym modelem transformerowym: klient otrzymuje model generujący tekst, a nie architekturę, w której wybrane koncepty są projektowanym celem treningu. RNM konkurują więc nie samym rozmiarem, tylko możliwością kontroli przyczyny zachowania modelu. Produkt Wisent obejmuje model, katalog kierunków konceptów, raport aktywacji i interwencję reprezentacyjną działającą podczas inferencji. Dla banku, administracji lub dostawcy systemu medycznego oznacza to możliwość wskazania, które własności modelu były aktywne przy odpowiedzi i jak zmieniono ich wpływ bez pełnego ponownego treningu.', 1000, 990, ['W porównaniu z Mistral RNM mają też silniejszą odpowiedź na strategiczną zależność: nie tylko europejski dostawca API, ale europejska technologia kontroli modeli, możliwa do wdrożenia lokalnie, wersjonowania i audytu w dokumentacji klienta. Przewaga będzie mierzona stabilnością kierunków, lokalnością interwencji i kompletnością raportu audytowego.']),
  },
  {
    podmiot: 'Aleph Alpha',
    kraj: 'Niemcy',
    produkt: fit('Aleph product', 'Modele językowe i rozwiązania enterprise dla administracji oraz sektorów regulowanych: generatywna AI, narzędzia zaufania, explainability i wdrożenia w środowiskach organizacji.', 200, 190, ['To bliski europejski punkt odniesienia.']),
    funkcjonalnosci: fit('Aleph funkcje', 'Obsługa zastosowań enterprise, generowanie i analiza tekstu, narzędzia wyjaśnialności oraz wdrożeń regulowanych, lecz wyjaśnienie nie jest tym samym co kontrola nazwanych reprezentacji.', 200, 190, ['Brak interwencji na konceptach.']),
    korzysc: fit('Aleph benefit', 'Aleph Alpha trafia w podobny segment odbiorców: administrację i przedsiębiorstwa, które wymagają zaufania, wyjaśnialności i zgodności. Różnica RNM polega na mechanizmie technicznym. W klasycznym podejściu explainability opisuje lub interpretuje wynik działania modelu po fakcie. W RNM raport aktywacji ma być częścią działania modelu, bo kierunki konceptów są stabilizowane i walidowane jako element treningu. Odbiorca nie dostaje wyłącznie informacji, że odpowiedź modelu można opisać; dostaje narzędzie do osłabienia, wzmocnienia albo zablokowania konkretnego konceptu w czasie inferencji.', 1000, 990, ['To istotna przewaga dla procesów wysokiego ryzyka, gdzie samo wyjaśnienie odpowiedzi nie wystarcza: potrzebna jest powtarzalna procedura nadzoru człowieka i dokumentowania interwencji. RNM mają mierzyć stabilność konceptów między wersjami, ortogonalność wobec innych kompetencji i wpływ interwencji na jakość generacji, co zamienia wyjaśnialność w kontrolowalną funkcję produktu. Ma to znaczenie dla audytu RNM.']),
  },
  {
    podmiot: 'H Company',
    kraj: 'Francja',
    produkt: fit('H product', 'Systemy agentowe i modele AI do automatyzacji pracy: orkiestracja zadań, produktywność, integracje aplikacyjne i narzędzia dla użytkowników biznesowych, zespołów operacyjnych i rynku UE.', 200, 190, ['Warstwa aplikacyjna, nie bazowy RNM.']),
    funkcjonalnosci: fit('H funkcje', 'Automatyzacja wieloetapowych zadań, agenci, workflow, integracje z aplikacjami, obsługa procesów pracy; kontrola zależy głównie od orkiestracji, reguł i zachowania modelu bazowego.', 200, 190, ['Nie rozwiązuje źródła zachowania.']),
    korzysc: fit('H benefit', 'H Company konkuruje o warstwę agentów i produktywności, natomiast RNM są niżej w łańcuchu wartości: mają być kontrolowaną warstwą modelową, na której takie agenty mogą działać. To rozróżnienie jest ważne dla oceny przewagi. Agent może mieć reguły, pamięć i integracje, ale jego ryzyka często wynikają z niekontrolowanego zachowania modelu bazowego: halucynacji, nadmiernej pewności, złamania polityki lub błędnej aktywacji kompetencji. RNM przenoszą część kontroli przed warstwę orkiestracji, do przestrzeni reprezentacji.', 1000, 990, ['Korzyść dla klienta polega na tym, że wdrożenie agentowe może korzystać z modelu, który raportuje aktywne koncepty i pozwala je modyfikować bez przebudowy całego workflow. W sektorach regulowanych UE daje to lepszy materiał audytowy niż same logi agenta: można pokazać nie tylko, jakie narzędzie agent wywołał, ale także jakie własności modelu były aktywne przy decyzji i jak kontrolowano je w kolejnych wersjach produktu. Log agenta łączy się z raportem reprezentacji.']),
  },
  {
    podmiot: 'LightOn',
    kraj: 'Francja',
    produkt: fit('LightOn product', 'Platforma generatywnej AI dla przedsiębiorstw: wdrożenia modeli, aplikacje organizacyjne, narzędzia pracy z danymi i integracja generatywnej AI w procesach biznesowych.', 200, 190, ['Porównanie dotyczy warstwy wdrożeniowej.']),
    funkcjonalnosci: fit('LightOn funkcje', 'Udostępnianie modeli i aplikacji generatywnych, obsługa danych firmowych, integracje w organizacji i wsparcie pracy użytkowników; kontrola modelu pozostaje warstwą aplikacyjną.', 200, 190, ['Brak natywnego audytu reprezentacji.']),
    korzysc: fit('LightOn benefit', 'LightOn jest platformą wdrażania generatywnej AI w organizacjach. RNM nie są kolejnym panelem do pracy z dokumentami, lecz technologią modelową, którą taka platforma mogłaby wykorzystać jako kontrolowany komponent bazowy. Przewaga Wisent polega na zmianie miejsca, w którym powstaje audytowalność: nie w zewnętrznym module wdrożeniowym, ale w konstrukcji modelu i jego reprezentacji. Dla klienta oznacza to, że dokumentacja zgodności nie musi opierać się tylko na konfiguracji platformy lub opisie procedury użytkownika.', 1000, 990, ['RNM dostarczają dane techniczne: wersję modelu, wersję katalogu konceptów, parametry interwencji, miary stabilności i raport aktywacji. Taki materiał jest istotny przy AI Act, bo pozwala wykazać nadzór człowieka i przejrzystość systemu na poziomie komponentu AI. LightOn pozostaje konkurentem wdrożeniowym, ale nie eliminuje zależności od klasycznych modeli bazowych ani nie tworzy natywnej powierzchni kontroli reprezentacji. Daje też kontrolę wersji modelu w UE i audycie.']),
  },
  {
    podmiot: 'Synerise S.A.',
    kraj: 'Polska',
    produkt: fit('Synerise product', 'Platforma AI do analizy zachowań, personalizacji, predykcji i automatyzacji decyzji biznesowych w czasie rzeczywistym dla handlu, finansów, dużych organizacji i rynku AI w Polsce.', 200, 190, ['Polski punkt odniesienia komercjalizacji AI.']),
    funkcjonalnosci: fit('Synerise funkcje', 'Analiza danych behawioralnych, rekomendacje, segmentacja, scoring, automatyzacja decyzji i personalizacja; produkt nie jest bazową architekturą generatywnego modelu językowego.', 200, 190, ['Inna warstwa rynku AI.']),
    korzysc: fit('Synerise benefit', 'Synerise pokazuje, że polska firma może skutecznie komercjalizować zaawansowaną AI, ale jej główny produkt dotyczy analityki, personalizacji i automatyzacji decyzji biznesowych. RNM adresują inną lukę: europejską warstwę modeli generatywnych, która może być bazą dla aplikacji regulowanych. Przewaga nie polega na zastąpieniu systemów predykcyjnych Synerise, lecz na dostarczeniu modelu językowego z natywną kontrolą reprezentacji, raportem aktywacji i możliwością lokalnej interwencji.', 1000, 990, ['Dla klienta oznacza to zastosowania, których klasyczna analityka nie obsługuje: audytowalne generowanie, kontrolowane wspomaganie decyzji, praca z tekstem i dokumentacją oraz integracja z procesami wymagającymi wyjaśnienia zachowania modelu. RNM mogą wzmacniać europejski łańcuch wartości AI, bo tworzą bazowy komponent możliwy do użycia przez integratorów, dostawców systemów branżowych i organizacje, które potrzebują generatywnej AI zgodnej z regulacjami UE. To inna warstwa produktu dla integratorów.']),
  },
];

const NON_EU = [
  {
    podmiot: 'Amerykański dostawca modeli GPT',
    kraj: 'USA',
    produkt: fit('GPT product', 'Zamknięte modele generatywne dostępne przez API i produkty enterprise: modele frontier, agenci, narzędzia deweloperskie, integracje i komercyjny ekosystem AI dla firm.', 200, 190, ['Pozaunijny punkt odniesienia jakościowego.']),
    funkcjonalnosci: fit('GPT funkcje', 'Generowanie, rozumowanie, kodowanie, narzędzia agentowe, multimodalność i API; użytkownik nie ma dostępu do treningu, reprezentacji, katalogu konceptów ani kontroli architektury.', 200, 190, ['Zależność od operatora modelu.']),
    korzysc: fit('GPT benefit', 'Zamknięte modele GPT są najsilniejszym punktem odniesienia jakościowego, ale ich kluczowa słabość dla UE nie dotyczy wyłącznie ceny lub benchmarku. Europejski odbiorca nie kontroluje architektury, procesu treningu, danych, polityki bezpieczeństwa ani reprezentacji wewnętrznych. RNM odpowiadają na tę zależność przez produkt, który może być rozwijany, hostowany i audytowany w europejskim środowisku. Katalog konceptów i raport aktywacji dają organizacji materiał techniczny, którego nie zapewnia zewnętrzne API: co było aktywne, jaka wersja katalogu działała i jaką interwencję zastosowano.', 1000, 990, ['Przewaga Wisent jest więc regulacyjna i produktowa: klient może budować system AI na kontrolowanej warstwie modelowej, zamiast importować czarnoskrzynkową usługę. W sektorach wysokiego ryzyka to ogranicza vendor lock-in, ułatwia dokumentację zgodności z AI Act i pozwala przenosić wiedzę do europejskiego łańcucha wartości. Wdrożenie może być audytowane w infrastrukturze klienta UE. To dowód kontroli.']),
  },
  {
    podmiot: 'Anthropic',
    kraj: 'USA',
    produkt: fit('Anthropic product', 'Rodzina modeli Claude dla przedsiębiorstw: bezpieczne modele generatywne, Constitutional AI, kontrolowane API, narzędzia pracy z dokumentami i wdrożenia enterprise.', 200, 190, ['Silny punkt odniesienia safety.']),
    funkcjonalnosci: fit('Anthropic funkcje', 'Generowanie i analiza tekstu, praca z długim kontekstem, zasady bezpieczeństwa, polityki odmowy i API; kontrola jest kształtowana przez zamknięty proces dostawcy.', 200, 190, ['Brak dostępu do reprezentacji modelu.']),
    korzysc: fit('Anthropic benefit', 'Anthropic buduje przewagę wokół bezpieczeństwa, zasad konstytucyjnych i kontrolowanego API. RNM rozwiązują inny problem: jak przenieść kontrolę z zamkniętego procesu dostawcy na mierzalne elementy architektury modelu dostępne dla operatora w UE. W RNM mechanizmem nie ma być tylko polityka zachowania, lecz nazwany kierunek konceptu, jego stabilność, ortogonalność i wpływ interwencji na generację. Dzięki temu odbiorca może odtworzyć, czy dana klasa ryzyka została rozpoznana i jak zmieniono jej wpływ w czasie inferencji.', 1000, 990, ['To jest szczególnie ważne w bankowości, administracji i zdrowiu: organizacja nie może opierać nadzoru wyłącznie na zaufaniu do operatora API spoza UE. RNM dają ścieżkę do lokalnego audytu, wersjonowania polityk jako konceptów i porównania zachowania między wersjami. Przewaga nie neguje jakości Claude; wskazuje, że kontrola bezpieczeństwa może być produktem europejskim, a nie usługą świadczoną wyłącznie z zewnątrz. Polityka bezpieczeństwa staje się mierzalnym elementem audytu.']),
  },
  {
    podmiot: 'Google DeepMind',
    kraj: 'USA / UK poza UE',
    produkt: fit('Google product', 'Modele Gemini i ekosystem Google AI: multimodalność, chmura, integracje z usługami Google, narzędzia dla firm oraz infrastruktura modelowa poza kontrolą UE.', 200, 190, ['To konkurent ekosystemowy, nie tylko model.']),
    funkcjonalnosci: fit('Google funkcje', 'Generowanie i analiza multimodalna, integracje chmurowe, narzędzia produktywności, API i skala infrastruktury; kontrola modelu jest powiązana z globalnym ekosystemem dostawcy.', 200, 190, ['Brak lokalnej kontroli architektury.']),
    korzysc: fit('Google benefit', 'Google DeepMind oferuje przewagę skali: modele, chmurę, integracje i produkty używane globalnie. RNM nie próbują zastąpić całego ekosystemu, lecz krytyczny element łańcucha wartości: warstwę modelową z audytem reprezentacji. Dla europejskiej organizacji różnica polega na tym, że technologia bazowa nie musi być związana z globalną chmurą i polityką dostawcy spoza UE. RNM mogą działać w uzgodnionej infrastrukturze europejskiej, z wersjonowanym katalogiem konceptów, dokumentacją treningu i raportem inferencji.', 1000, 990, ['Taka architektura ogranicza strategiczną zależność nie przez izolację od rynku, lecz przez posiadanie własnego komponentu bazowego, który można integrować z aplikacjami i audytować. Przewaga jest szczególnie istotna tam, gdzie dane, polityka bezpieczeństwa i zgodność regulacyjna nie mogą być podporządkowane ekosystemowi jednego pozaunijnego dostawcy. Klient UE zachowuje wpływ na roadmapę, walidację języków, miejsce hostingu i materiał dowodowy dla kontroli. Ułatwia niezależny audyt.']),
  },
  {
    podmiot: 'Meta AI',
    kraj: 'USA',
    produkt: fit('Meta product', 'Rodzina modeli Llama i narzędzia open-weight: klasyczny transformer, szeroka adopcja deweloperska, możliwość własnego hostingu i duży ekosystem społecznościowy.', 200, 190, ['Otwarte wagi, ale bez natywnego RNM.']),
    funkcjonalnosci: fit('Meta funkcje', 'Własne wdrożenia modeli, fine-tuning, eksperymenty deweloperskie, integracje open-source i szerokie użycie w produktach; brak katalogu konceptów z procesu treningu.', 200, 190, ['Audyt wymaga narzędzi zewnętrznych.']),
    korzysc: fit('Meta benefit', 'Llama jest ważnym modelem referencyjnym, bo otwarte wagi ograniczają część zależności od API. Nie rozwiązują jednak problemu, który adresują RNM: otwartość wag nie oznacza natywnej audytowalności zachowania, stabilnego katalogu konceptów ani możliwości kontrolowania nazwanych własności modelu podczas inferencji. RNM łączą wdrażalność modelu z zaprojektowaną warstwą kontroli reprezentacji. Klient nie dostaje tylko pliku wag i obowiązku samodzielnego budowania narzędzi bezpieczeństwa; otrzymuje model z procedurą walidacji konceptów i raportowania aktywacji.', 1000, 990, ['Przewaga wobec Llama polega na przejściu od „modelu, który można uruchomić” do „modelu, którego zachowanie można mierzyć i korygować na poziomie reprezentacji”. Dla UE jest to różnica strategiczna: samo open-weight nadal opiera się na pozaunijnym źródle architektury i roadmapy, natomiast RNM rozwijają kompetencję projektowania modeli bazowych wewnątrz europejskiego łańcucha wartości.']),
  },
  {
    podmiot: 'Alibaba Cloud / Qwen',
    kraj: 'Chiny',
    produkt: fit('Qwen product', 'Rodzina modeli Qwen i usługi Alibaba Cloud AI: modele open-weight, API, narzędzia chmurowe i ekosystem rozwijany poza UE, z silną pozycją technologiczną Chin oraz adopcją techniczną.', 200, 190, ['Konkurent skali i adopcji.']),
    funkcjonalnosci: fit('Qwen funkcje', 'Generowanie, kodowanie, rozumowanie, modele wielojęzyczne i wdrożenia chmurowe; możliwość użycia otwartych wag, lecz bez unijnej kontroli roadmapy i procesu treningu UE.', 200, 190, ['Brak audytu konceptów.']),
    korzysc: fit('Qwen benefit', 'Qwen pokazuje, że pozaeuropejscy dostawcy potrafią szybko budować modele otwartych wag i zdobywać adopcję techniczną. Dla UE pozostaje jednak zależność od pozaunijnego źródła technologii bazowej, decyzji licencyjnych, priorytetów językowych i ekosystemu narzędziowego. RNM tworzą alternatywę w tej samej warstwie łańcucha wartości: model bazowy i procedury kontroli rozwijane w UE. Przewaga nie polega tylko na pochodzeniu geograficznym, lecz na funkcji, której Qwen nie zapewnia natywnie: katalogu konceptów, raporcie aktywacji i interwencji reprezentacyjnej.', 1000, 990, ['Dla odbiorcy regulowanego oznacza to możliwość wykazania, jak zachowanie modelu jest kontrolowane, a nie tylko że model ma dobre wyniki. Projekt wzmacnia także wielojęzyczne zastosowania UE, bo katalog i walidacja mogą obejmować polski, niemiecki, francuski i hiszpański jako cele produktu, a nie efekt uboczny globalnego treningu.']),
  },
  {
    podmiot: 'DeepSeek',
    kraj: 'Chiny',
    produkt: fit('DeepSeek product', 'Modele językowe i rozumujące open-weight: efektywny trening, niskokosztowa inferencja, modele reasoning i silny nacisk na wydajność obliczeniową poza UE oraz koszt wdrożeń.', 200, 190, ['Konkurent kosztowy.']),
    funkcjonalnosci: fit('DeepSeek funkcje', 'Rozumowanie, kodowanie, efektywna inferencja i wykorzystanie otwartych wag; przewaga kosztowa nie obejmuje natywnego raportu aktywacji ani kontroli reprezentacji.', 200, 190, ['Brak zgodnościowej powierzchni audytu.']),
    korzysc: fit('DeepSeek benefit', 'DeepSeek jest konkurentem efektywnościowym: pokazał znaczenie kosztu treningu, kosztu inferencji i modeli rozumujących. RNM muszą być porównywane z takim punktem odniesienia kosztowego, ale rozwijają dodatkową wartość produktową: sterowalność i audyt reprezentacji. Dla klienta regulowanego sama efektywność nie wystarcza, jeżeli model nie pozwala udokumentować przyczyn zachowania i kontrolować nazwanych konceptów. RNM łączą cel kosztowy z warstwą kontroli, w której można mierzyć lokalność interwencji, kompletność raportu aktywacji i stabilność katalogu konceptów między wersjami modelu.', 1000, 990, ['Przewaga wobec DeepSeek jest więc dwojaka: europejska autonomia technologii bazowej oraz mechanizm zgodnościowy przydatny przy AI Act. Jeżeli RNM osiągną parytet jakości przy mniejszej liczbie tokenów lub niższym koszcie inferencji, korzyść nie będzie tylko finansowa; będzie obejmować możliwość kontrolowania źródła zachowania modelu w środowisku klienta.']),
  },
  {
    podmiot: 'Goodfire AI',
    kraj: 'USA',
    produkt: fit('Goodfire product', 'Narzędzia interpretowalności i inżynierii reprezentacji: analiza aktywacji, identyfikacja cech, projektowanie zachowania i praca na modelach oraz systemach AI już istniejących.', 200, 190, ['Najbliższy konkurent metod reprezentacyjnych.']),
    funkcjonalnosci: fit('Goodfire funkcje', 'Analiza reprezentacji gotowych modeli, diagnostyka zachowania, wykrywanie cech, steering aktywacji i eksperymenty po treningu; rozwiązanie nie jest własnym modelem bazowym RNM.', 200, 190, ['Kontrola po treningu.']),
    korzysc: fit('Goodfire benefit', 'Goodfire jest najbliżej problemu reprezentacji, dlatego porównanie jest merytorycznie najostrzejsze. Różnica polega na miejscu w cyklu życia modelu. Goodfire analizuje i steruje modelami już wytrenowanymi, natomiast RNM mają stabilizować i separować kierunki konceptów jako część treningu modelu. To przesuwa reprezentacje z roli narzędzia diagnostycznego do roli cechy produktu modelowego. Klient nie dostaje wyłącznie narzędzia do oglądania cudzego modelu, lecz model, katalog i mechanizm inferencji zaprojektowane razem.', 1000, 990, ['Przewaga Wisent polega na zamknięciu pętli: funkcje celu tworzą reprezentacje, procedura walidacji ocenia ich stabilność, a interfejs inferencji pozwala na kontrolę i raportowanie. W efekcie audytowalność nie zależy od dopasowania zewnętrznego narzędzia do modelu dostawcy, ale jest częścią architektury RNM. To bezpośrednio odpowiada zarzutowi, że reprezentacje już istnieją: nowy jest sposób ich użycia jako projektowanego celu treningu.']),
  },
  {
    podmiot: 'Transluce',
    kraj: 'USA',
    produkt: fit('Transluce product', 'Narzędzia interpretowalności, obserwowalności i monitorowania modeli AI: diagnostyka zachowania, analiza ryzyka, inspekcja działania gotowych modeli już używanych.', 200, 190, ['Konkurent w warstwie monitoringu.']),
    funkcjonalnosci: fit('Transluce funkcje', 'Obserwowanie zachowania modeli, analiza odpowiedzi, diagnostyka ryzyka i wsparcie zrozumienia systemów AI; korekta nadal zależy od modelu bazowego i procesu wdrożenia.', 200, 190, ['Nie jest to architektura modelu.']),
    korzysc: fit('Transluce benefit', 'Transluce wzmacnia obserwowalność i diagnostykę systemów AI, czyli pomaga zrozumieć zachowanie modelu podczas użytkowania. RNM mają wbudować część tej obserwowalności w samą inferencję modelu: raport aktywacji konceptów jest produktem ubocznym kontrolowanej generacji, a nie zewnętrznym raportem diagnostycznym po fakcie. Korzyść dla klienta polega na skróceniu drogi od obserwacji do korekty. System nie tylko pokazuje, że zachowanie jest ryzykowne, lecz pozwala powiązać ryzyko z nazwanym konceptem i zastosować interwencję reprezentacyjną.', 1000, 990, ['To odróżnia RNM od narzędzi monitorowania gotowych modeli. Wdrożenie regulowane wymaga nie tylko wykrycia problemu, ale też udokumentowanej procedury zmiany zachowania i potwierdzenia, że zmiana nie uszkodziła innych kompetencji. RNM projektują tę procedurę jako funkcję produktu, mierzoną lokalnością interwencji, stabilnością katalogu i kompletnością raportu aktywacji.']),
  },
  {
    podmiot: 'Gray Swan AI',
    kraj: 'USA',
    produkt: fit('Gray product', 'Platforma adversarial evaluation, red-teamingu i ochrony wdrożeń produkcyjnych AI: testy jailbreak, prompt injection, ryzyka agentów i bezpieczeństwo runtime.', 200, 190, ['Konkurent bezpieczeństwa operacyjnego.']),
    funkcjonalnosci: fit('Gray funkcje', 'Testowanie podatności modeli i agentów, ocena niepożądanych wyjść, red-team, ochrona wdrożeń i monitoring ryzyka; korekta działa głównie poza modelem bazowym.', 200, 190, ['Kontrola wewnętrzna nie jest rdzeniem.']),
    korzysc: fit('Gray benefit', 'Gray Swan koncentruje się na testowaniu przeciwnym, red-teamingu i ochronie runtime przed niepożądanymi zachowaniami. RNM nie zastępują red-teamingu; zmieniają miejsce reakcji. Część kontroli ma działać na poziomie reprezentacji modelu, zanim zachowanie zostanie przepuszczone przez zewnętrzny filtr lub blokadę. Dla odbiorcy przewaga polega na połączeniu testów bezpieczeństwa z mechanizmem korekty wewnątrz modelu. Jeżeli red-team wykryje klasę ryzyka, RNM może przypisać ją do konceptu, monitorować aktywację i ograniczać ją podczas inferencji.', 1000, 990, ['To ogranicza zależność od dokładania kolejnych reguł ochronnych po każdym nowym ataku. W dokumentacji zgodności można pokazać nie tylko listę testów, ale również zmianę mierzalnego parametru reprezentacji i wpływ tej zmiany na zachowanie modelu. Takie przejście od testu do kontrolowanej korekty jest szczególnie ważne dla systemów wysokiego ryzyka i klientów, którzy muszą utrzymywać dowód nadzoru człowieka.']),
  },
];

const PARAMS = [
  {
    name: fit('p1 name', 'Liczba płatnych odbiorców enterprise spoza rynku wewnętrznego UE korzystających z modeli RNM Wisent w roku docelowym, liczona jako aktywni klienci z umową, fakturą lub billingiem API; wskaźnik wyłącza konta testowe, leady, bezpłatne pilotaże, podmioty powiązane i klientów z rynku wewnętrznego UE, a kraj przypisuje według siedziby kontrahenta.', 500, 490, ['Pomiar dotyczy wyłącznie produktu RNM, nie usług doradczych, PR ani wdrożeń niezwiązanych z katalogiem konceptów.']),
    base: '0 (odbiorcy)', baseYear: '2026', target: '5 (odbiorcy)', targetYear: '2033',
    method: fit('p1 method', 'Wartość 5 odbiorców poza rynkiem wewnętrznym UE przyjęto jako efekt uboczny komercjalizacji prowadzonej przede wszystkim w UE. Punkt wyjścia to 50 klientów enterprise w UE i założenie, że ograniczona liczba wdrożeń globalnych pojawi się przez publikacje open-source, relacje z obecnymi użytkownikami biblioteki Wisent oraz zapytania od organizacji regulowanych działających międzynarodowo. Wskaźnik nie służy do wykazania potencjału rynku wewnętrznego UE; pokazuje jedynie, że produkt bazowy może mieć eksportowy ogon sprzedaży bez przesuwania strategii poza Unię.', 1000, 990, ['Konserwatyzm polega na tym, że pięciu klientów odpowiada tylko 10% docelowej bazy unijnej i wymaga realnej odpłatności: umowy, faktury albo aktywnego billingu API. Nie liczymy pobrań open-source, próbnych kont, zapytań sprzedażowych ani partnerstw bez przychodu. Taka metoda oddziela podstawowy efekt STEP od dodatkowego eksportu i nie zawyża potencjału gospodarczego.']),
    verify: fit('p1 verify', 'Weryfikacja będzie prowadzona w rejestrze klientów RNM z krajem siedziby, numerem umowy, statusem płatności i wskazaniem, czy kontrahent znajduje się poza rynkiem wewnętrznym UE. Dla każdego odbiorcy wymagane będą faktura, umowa lub zapis billingu API oraz potwierdzenie, że dostęp dotyczy produktu RNM, a nie jednorazowej usługi. Zliczenie nastąpi na koniec roku docelowego przez unikalne podmioty, bez duplikowania spółek z tej samej grupy. Dowody będą przechowywane w CRM, księgach i dokumentacji projektu.', 800, 790, ['Kontrola odrzuci leady, bezpłatne testy, konta demonstracyjne i użytkowników bez aktywnej płatnej relacji.']),
  },
  {
    name: fit('p2 name', 'Wartość rocznych przychodów netto Wisent Polska ze sprzedaży modeli RNM klientom spoza rynku wewnętrznego UE w roku docelowym, liczona według faktur, umów licencyjnych i billingu API; wskaźnik nie obejmuje VAT, dotacji, usług jednorazowych, doradztwa bez dostępu do RNM, transakcji wewnątrzgrupowych ani przychodów od klientów z UE.', 500, 490, ['Przychód musi być przypisany w księgach do produktu RNM i kraju siedziby kontrahenta poza rynkiem wewnętrznym.']),
    base: '0 PLN', baseYear: '2026', target: '3 000 000 PLN', targetYear: '2033',
    method: fit('p2 method', 'Kwotę 3 000 000 PLN wyliczono jako konserwatywne 10% planowanego rocznego przychodu z RNM w 2033 r., wynoszącego 30 000 000 PLN. Drugi sposób sprawdzenia prowadzi do tej samej skali: pięciu klientów poza UE przy cenie około 150 000 USD rocznie i kursie 4,00 PLN/USD daje 3 mln PLN. Założenie nie przesuwa projektu w stronę globalnej komercjalizacji kosztem rynku wewnętrznego; przychód poza UE jest traktowany jako uzupełnienie wynikające z widoczności technologii open-source i z kontaktów enterprise.', 1000, 990, ['Nie zakładamy przychodów reklamowych, sublicencji od podmiotów powiązanych ani jednorazowych usług technicznych bez dostępu do RNM. Wartość docelowa jest więc spójna z liczbą klientów, ceną pakietu enterprise i strategią, w której co najmniej 90% przychodów pozostaje związane z rynkiem UE. Weryfikacja geograficzna opiera się na siedzibie kontrahenta z umowy i faktury, nie na lokalizacji użytkownika końcowego.']),
    verify: fit('p2 verify', 'Źródłem weryfikacji będą faktury sprzedaży, umowy licencyjne/API, ewidencja przychodów w księgach, rejestr klientów z krajem siedziby i raport roczny przypisujący przychody do produktu RNM. Każda pozycja przychodu musi mieć walutę, kurs przeliczenia, datę faktury, numer kontrahenta i oznaczenie, że nie dotyczy rynku wewnętrznego UE. Sumowanie będzie wykonane netto, bez VAT, dotacji i usług niepowiązanych z RNM. Dowody księgowe i CRM muszą pozwalać odtworzyć wyliczenie podczas kontroli.', 800, 790, ['Jeżeli faktura obejmuje kilka usług, do wskaźnika zostanie zaliczona tylko część opisana jako RNM.']),
  },
  {
    name: fit('p3 name', 'Liczba klientów z listy Fortune 500 Europe odpłatnie korzystających z modeli RNM Wisent w roku docelowym, potwierdzona umową, fakturą lub aktywnym billingiem API; wskaźnik obejmuje wdrożenia produkcyjne i płatne pilotaże, wyłącza leady, bezpłatne testy, partnerów bez przychodu oraz podmioty spoza listy zweryfikowanej na rok pomiaru.', 500, 490, ['Kraj siedziby i kwalifikacja klienta będą zapisane w rejestrze kont enterprise oraz dokumentacji sprzedaży.']),
    base: '0 (klienci)', baseYear: '2026', target: '50 (klienci)', targetYear: '2032',
    method: fit('p3 method', 'Model target-account obejmuje duże europejskie przedsiębiorstwa, dla których kontrola, audyt i wdrożenie w UE mają znaczenie: finanse, ubezpieczenia, ochrona zdrowia, cyberbezpieczeństwo, telekomunikacja, infrastruktura, administracja i dostawcy oprogramowania. Przyjęto populację 264 kwalifikowanych kont z listy Fortune 500 Europe oraz współczynnik wygranych 19% dla sprzedaży B2B enterprise, co daje 50,16 i zostało zaokrąglone w dół do 50 klientów. To około 10% penetracji populacji, czyli cel ambitny, ale spójny z produktem bazowym dla wielu branż.', 1000, 990, ['Założenie uwzględnia długi cykl sprzedaży: najpierw pilotaże płatne, następnie umowy roczne i rozszerzenia do kolejnych jednostek klienta. Nie liczymy bezpłatnych proof-of-concept ani rozmów z grupą kapitałową bez umowy. Wskaźnik jest ważny, bo pokazuje nie tylko przychód, lecz akceptację technologii RNM przez odbiorców o wysokich wymaganiach regulacyjnych i zakupowych.']),
    verify: fit('p3 verify', 'Weryfikacja będzie oparta na umowach licencyjnych, fakturach, aktywnym billingu API, protokołach odbioru pilotażu, rejestrze klientów Wisent oraz kopii lub odwołaniu do listy Fortune 500 Europe użytej w roku pomiaru. Każdy klient zostanie wpisany raz, według grupy kapitałowej i kraju siedziby wskazanego w umowie. Status płatny oznacza zaksięgowany przychód lub aktywną fakturę, a nie samą zgodę na testy. Dokumentacja będzie zawierała numer umowy, datę startu, zakres produktu RNM i osobę odpowiedzialną za rejestr.', 800, 790, ['Kontrola umożliwi śledzenie od pozycji w CRM do faktury i umowy.']),
  },
  {
    name: fit('p4 name', 'Roczne przychody netto Wisent Polska ze sprzedaży modeli RNM klientom enterprise na rynku wewnętrznym UE w roku docelowym, mierzone według faktur, umów licencyjnych i billingu API; wskaźnik wyłącza VAT, dotacje, prace jednorazowe niezwiązane z RNM, rabaty niefakturowane, przychody od podmiotów powiązanych i sprzedaż poza UE.', 500, 490, ['Do wartości zalicza się tylko dostęp do modeli, katalogu konceptów, API, wsparcia wdrożeniowego i aktualizacji RNM.']),
    base: '0 PLN', baseYear: '2026', target: '30 000 000 PLN', targetYear: '2032',
    method: fit('p4 method', 'Wartość 30 000 000 PLN wyliczono jako 50 klientów enterprise × 150 000 USD rocznie × kurs 4,00 PLN/USD. Cena odpowiada pakietowi obejmującemu dostęp do modeli RNM, limity API, aktualizacje katalogu konceptów, dokumentację audytową i wsparcie wdrożeniowe dla klienta regulowanego. Nie wliczono tańszych licencji self-service, doradztwa niezwiązanego z RNM ani jednorazowych integracji. Metoda jest konserwatywna, bo zakłada stałą cenę roczną, brak wzrostu ceny wraz z wolumenem i brak dosprzedaży modułów branżowych.', 1000, 990, ['Wskaźnik odzwierciedla potencjał rynku wewnętrznego UE: produkt ma być używany przez odbiorców z wielu sektorów i państw, ale przychód jest liczony wyłącznie wtedy, gdy istnieje faktura albo billing API przypisany do RNM. Przyjęcie 50 klientów jest zgodne z parametrem target-account i z założeniem, że bazowy model może być sprzedawany do wielu branż bez budowania osobnego produktu od zera dla każdej organizacji.']),
    verify: fit('p4 verify', 'Monitorowanie obejmie ewidencję przychodów netto w księgach, faktury sprzedaży, umowy licencyjne/API, raport z systemu billingowego i rejestr klientów z oznaczeniem rynku wewnętrznego UE. Dla każdej pozycji przychodu zostanie zachowany numer faktury, data, kontrahent, kraj siedziby, opis produktu i kwota przypisana do RNM. Jeżeli umowa obejmie także prace wdrożeniowe lub doradcze, do wskaźnika wejdzie tylko część dotycząca dostępu do modeli, katalogu konceptów, API lub aktualizacji RNM.', 800, 790, ['Roczna suma będzie uzgadniana z księgami rachunkowymi i sprawozdaniem finansowym.']),
  },
  {
    name: fit('p5 name', 'Skumulowane przychody netto Wisent Polska ze sprzedaży modeli RNM na rynku wewnętrznym UE od pierwszego pełnego roku komercjalizacji do roku docelowego, liczone narastająco według faktur, umów licencyjnych, billingu API i ewidencji księgowej; wskaźnik wyłącza VAT, dotacje, usługi spoza RNM i przychody od podmiotów powiązanych.', 500, 490, ['Zakres obejmuje tylko produkt RNM oferowany odbiorcom z UE, nie prace przygotowawcze finansowane w projekcie.']),
    base: '0 PLN', baseYear: '2026', target: '62 400 000 PLN', targetYear: '2033',
    method: fit('p5 method', 'Skumulowaną wartość 62 400 000 PLN wyliczono jako sumę czterech pierwszych pełnych lat sprzedaży RNM na rynku wewnętrznym UE. Założono narastanie bazy klientów: 6 klientów w 2030 r., 16 w 2031 r., 32 w 2032 r. i 50 w 2033 r. Przy cenie 150 000 USD rocznie i kursie 4,00 PLN/USD daje to odpowiednio 3,6 mln PLN, 9,6 mln PLN, 19,2 mln PLN i 30,0 mln PLN. Krzywa wzrostu zakłada wolniejszy start po zakończeniu B+R, a następnie skalowanie dzięki referencjom wdrożeniowym i partnerom integracyjnym.', 1000, 990, ['Nie przyjęto natychmiastowej sprzedaży pełnej skali, bo produkt bazowy dla sektorów regulowanych wymaga walidacji, procedur zakupowych i audytu po stronie klienta. Do wskaźnika zaliczane będą tylko przychody przypisane do RNM w UE, bez VAT, dotacji i usług pobocznych. Suma pokazuje trwały efekt gospodarczy, a nie jednorazową transakcję w roku końcowym.']),
    verify: fit('p5 verify', 'Weryfikacja będzie polegać na rocznym zestawieniu zaksięgowanych przychodów ze sprzedaży RNM za lata 2030-2033, uzgodnionym z fakturami, umowami, billingiem API i sprawozdaniami finansowymi. Każdy rok otrzyma osobny arkusz z listą klientów, kwotą netto, krajem siedziby i opisem produktu. Suma narastająca będzie możliwa do odtworzenia od pojedynczej faktury do wartości skumulowanej. Nie będą uwzględniane dotacje, VAT, usługi doradcze bez dostępu do RNM ani przychody od podmiotów powiązanych.', 800, 790, ['Dowody zostaną zapisane w księgach, CRM i dokumentacji kontroli projektu.']),
  },
  {
    name: fit('p6 name', 'Roczne przychody Wisent Polska ze sprzedaży modeli RNM do klientów z rynku wewnętrznego UE poza Polską w roku docelowym, obejmujące licencje, dostęp API, wdrożenia produkcyjne i aktualizacje katalogu konceptów; wskaźnik wyłącza VAT, dotacje, testy bezpłatne, prace niezwiązane z RNM, klientów polskich i sprzedaż poza UE.', 500, 490, ['Kraj przypisuje się według siedziby kontrahenta z umowy i faktury, nie według lokalizacji pojedynczego użytkownika.']),
    base: '0 PLN', baseYear: '2026', target: '24 000 000 PLN', targetYear: '2033',
    method: fit('p6 method', 'Wartość 24 000 000 PLN wyliczono jako 80% zakładanego rocznego przychodu 30 000 000 PLN z RNM w 2033 r. Założenie wynika z charakteru produktu: RNM ma być technologią bazową dla rynku wewnętrznego UE, a nie rozwiązaniem wyłącznie krajowym. Priorytetowe rynki to państwa z dużą liczbą regulowanych odbiorców AI: Niemcy, Francja, Włochy, Hiszpania, Beneluks, kraje nordyckie i Irlandia. Wskaźnik będzie liczony według kraju siedziby klienta z umowy lub faktury, a nie według lokalizacji użytkownika końcowego.', 1000, 990, ['Metoda oddziela przychody z Polski od przychodów z pozostałych państw UE, co pozwala ocenić faktyczny efekt transgraniczny. Nie zakłada się sprzedaży masowej do całej UE naraz; przychody rosną przez referencje wdrożeniowe, partnerów integracyjnych i sektory, w których audytowalna AI ma największą wartość. Kwota odpowiada około 40 klientom enterprise przy tej samej cenie rocznej co w modelu podstawowym.']),
    verify: fit('p6 verify', 'Weryfikacja obejmie rejestr klientów RNM z krajem siedziby, faktury z numerem VAT UE lub innym identyfikatorem kontrahenta, umowy licencyjne/API, raport z systemu billingowego oraz ewidencję przychodów według geografii. Do wskaźnika wejdą wyłącznie przychody od klientów z państw UE innych niż Polska, przypisane do produktu RNM. Każda pozycja będzie miała dokument księgowy, opis produktu, datę, kwotę netto i kraj kontrahenta. Suma zostanie uzgodniona z księgami i sprawozdaniem finansowym.', 800, 790, ['Sprzedaż w Polsce i poza UE będzie raportowana osobno.']),
  },
  {
    name: fit('p7 name', 'Liczba państw członkowskich UE, z których pochodzą płatni klienci enterprise korzystający z modeli RNM Wisent w roku docelowym, liczona według kraju siedziby kontrahenta z umowy lub faktury; wskaźnik wyłącza leady, testy bezpłatne, podmioty powiązane, klientów spoza UE oraz duplikaty spółek tej samej grupy.', 500, 490, ['Państwo zostanie zaliczone tylko wtedy, gdy istnieje co najmniej jeden aktywny płatny klient RNM.']),
    base: '0 (państw)', baseYear: '2026', target: 'min. 6 (państw)', targetYear: '2033',
    method: fit('p7 method', 'Próg co najmniej 6 państw UE przyjęto jako minimalny dowód, że RNM nie pozostają produktem lokalnym, lecz osiągają wymiar rynku wewnętrznego. Przy docelowej bazie 50 klientów enterprise próg oznacza średnio nieco ponad 8 klientów na państwo, ale w praktyce spodziewana jest koncentracja w kilku dużych rynkach i pojedyncze wdrożenia w mniejszych krajach. Cel jest więc realistyczny: wymaga sprzedaży transgranicznej, ale nie zakłada nierealnego pokrycia całej UE w pierwszych latach komercjalizacji.', 1000, 990, ['Państwa zostaną dobrane według sektorów regulowanych, dostępności partnerów integracyjnych i języków walidacji produktu. Niemcy, Francja, Hiszpania, Włochy, Beneluks, kraje nordyckie i Irlandia są naturalnymi kierunkami, bo łączą duże przedsiębiorstwa z wymogami nadzoru nad AI. Do wskaźnika nie będą liczone leady, bezpłatne testy ani zapytania sprzedażowe; potrzebna jest aktywna umowa, faktura lub billing API.']),
    verify: fit('p7 verify', 'Monitorowanie będzie prowadzone w rejestrze klientów RNM, w którym każdy kontrahent ma kraj siedziby, numer umowy, status płatności i datę aktywacji produktu. Na koniec roku docelowego zostanie policzona liczba różnych państw członkowskich UE reprezentowanych przez aktywnych płatnych klientów. Jeżeli kilka spółek z jednej grupy ma tę samą siedzibę, państwo zostanie policzone raz. Dowodami będą umowy, faktury, dane rejestrowe, raport CRM i billing API. Zestawienie będzie przechowywane z regułą deduplikacji.', 800, 790, ['Kontrola umożliwi przejście od państwa do konkretnego klienta i dokumentu sprzedaży.']),
  },
  {
    name: fit('p8 name', "Liczba odbiorców MŚP, software house'ów i integratorów korzystających z RNM w modelu otwartym lub komercyjnym w roku docelowym, potwierdzona aktywnymi kontami, kluczami API, umowami, fakturami, zgłoszeniami wdrożeniowymi albo zweryfikowanymi pobraniami; wskaźnik wyłącza boty, duplikaty, anonimowy ruch i testy bez organizacji.", 500, 490, ['Odbiorca musi być powiązany z konkretną organizacją i użyciem RNM, nie z samym wejściem na stronę.']),
    base: '0', baseYear: '2026', target: '120', targetYear: '2033',
    method: fit('p8 method', "Wartość 120 odbiorców opiera się na istniejącej bazie technicznej Wisent: bibliotece open-source z ponad 200 000 pobrań i ponad 300 gwiazdkami GitHub. Przyjęto ostrożną konwersję małej części użytkowników technicznych na płatnych odbiorców licencji, kont API lub wdrożeń komercyjnych. Wskaźnik obejmuje MŚP, software house'y i integratorów, którzy nie muszą kupować pełnego pakietu enterprise, ale mogą używać RNM jako komponentu w projektach dla klientów albo w produktach branżowych.", 1000, 990, ['Docelowe 120 odbiorców oznacza ułamek obecnej społeczności technicznej, a więc nie zakłada masowej adopcji. Do wartości zostaną zaliczone tylko organizacje możliwe do identyfikacji: aktywne konta, klucze API, umowy, faktury, zgłoszenia wdrożeniowe lub pobrania powiązane z firmowym kontem. Pobrania anonimowe, boty CI/CD, duplikaty użytkowników tej samej organizacji i jednorazowe testy bez kontynuacji nie zwiększą wskaźnika.']),
    verify: fit('p8 verify', 'Weryfikacja będzie łączyć system kont API, rejestr subskrypcji, billing, CRM, repozytorium zgłoszeń wdrożeniowych i faktury. Każdy odbiorca otrzyma identyfikator organizacji, kraj, typ użycia RNM i dowód aktywności w roku docelowym. Deduplikacja usunie wielu użytkowników z jednej firmy, boty, anonimowe pobrania i konta testowe bez dalszej aktywności. W przypadku modelu otwartego potwierdzeniem będzie zgłoszenie wdrożenia, firmowy klucz, issue/PR powiązany z organizacją albo deklaracja użycia potwierdzona kontaktem.', 800, 790, ['Raport końcowy pokaże metodę deduplikacji i listę dowodów.']),
  },
  {
    name: fit('p9 name', 'Liczba miejsc pracy w przeliczeniu na EPC utworzonych w Wisent Polska w związku z komercjalizacją modeli RNM, obejmująca role B+R, MLOps, wdrożeniowe, bezpieczeństwa, sprzedaży technicznej i obsługi klienta; wskaźnik liczony według umów, list płac, zakresów obowiązków i przypisania stanowiska do produktu RNM.', 500, 490, ['Nie obejmuje funkcji ogólnoadministracyjnych finansowanych wyłącznie z kosztów pośrednich ani stanowisk niezwiązanych z RNM.']),
    base: '0 (pracowników)', baseYear: '2026', target: '40 (pracowników)', targetYear: '2033',
    method: fit('p9 method', "Liczbę 40 EPC oszacowano od strony skali przychodu i zakresu operacyjnego produktu. Przy rocznym przychodzie około 7,5 mln USD oraz produktywności 150-200 tys. EUR przychodu na pracownika w rosnącej firmie software'owej potrzebny jest zespół rzędu 35-47 osób. Przyjęto wartość środkową i ostrożnie zaokrąglono do 40 EPC. Struktura zatrudnienia obejmie role techniczne i produktowe: dalsze B+R nad wersjami RNM, MLOps, utrzymanie infrastruktury, inżynierię wdrożeń, bezpieczeństwo, sprzedaż techniczną i obsługę klientów.", 1000, 990, ['Wskaźnik nie oznacza, że wszystkie osoby powstaną w trakcie projektu B+R; dotyczy efektu gospodarczego komercjalizacji po wdrożeniu. Do wartości będą liczone tylko stanowiska z rzeczywistym przypisaniem do RNM, proporcjonalnie do czasu pracy, jeżeli dana osoba pracuje także przy innych produktach. Metoda jest spójna z przychodami: zespół tej skali pozwala obsłużyć około 50 klientów enterprise i 120 mniejszych odbiorców bez zawyżania zatrudnienia.']),
    verify: fit('p9 verify', 'Weryfikacja będzie oparta na dokumentach kadrowych: umowach o pracę, umowach cywilnoprawnych, listach płac, deklaracjach ZUS, zakresach obowiązków i ewidencji czasu przypisanej do RNM. Każda osoba zostanie przeliczona na średnioroczny ekwiwalent pełnego czasu pracy, a częściowe zaangażowanie będzie liczone proporcjonalnie. Rejestr wskaże stanowisko, datę zatrudnienia, wymiar etatu, koszt lub wynagrodzenie oraz powiązanie z produktem RNM. Nie będą liczone role ogólne bez związku z komercjalizacją RNM.', 800, 790, ['Dokumentacja umożliwi odtworzenie wartości EPC i kontroli deduplikacji.']),
  },
  {
    name: fit('p10 name', 'Liczba nowych projektów B+R+I uruchomionych przez Wisent w wyniku realizacji projektu RNM, obejmująca dalsze badania, rozwój funkcji, sektorowe rozszerzenia, walidację językową lub projekty z partnerami UE; wskaźnik liczy tylko przedsięwzięcia z kartą projektu, właścicielem, budżetem, harmonogramem i powiązaniem z rezultatami RNM.', 500, 490, ['Nie obejmuje zwykłej sprzedaży, utrzymania klienta, PR, marketingu ani rutynowych aktualizacji produktu.']),
    base: '0 (projekty)', baseYear: '2026', target: '3 (projekty)', targetYear: '2033',
    method: fit('p10 method', 'Wartość 3 projektów B+R+I wynika z planu dalszego rozwoju RNM w trzech sektorach, w których potrzeba kontroli i audytu jest szczególnie silna: finanse, ochrona zdrowia i cyberbezpieczeństwo. Każdy projekt będzie miał odrębną kartę, właściciela, budżet i zakres techniczny, np. sektorowy katalog konceptów, metryki bezpieczeństwa, walidację językową, procedury integracji z systemami klienta lub badania nad kontrolą nowych klas ryzyka. Nie będą liczone zwykłe wdrożenia, prace utrzymaniowe ani działania sprzedażowe.', 1000, 990, ['Wskaźnik pokazuje zdolność rezultatu projektu do generowania kolejnych prac innowacyjnych, a nie tylko jednorazowej sprzedaży modelu. Przyjęto trzy projekty, bo odpowiadają głównym sektorom, które mogą wymagać odrębnych katalogów konceptów i metryk zgodności. Liczba jest realistyczna: wymaga powstania portfela dalszych inicjatyw, ale nie zakłada uruchomienia osobnego programu badawczego dla każdej branży w UE.']),
    verify: fit('p10 verify', 'Weryfikacja będzie oparta na wewnętrznym rejestrze projektów B+R+I, kartach projektów, decyzjach o finansowaniu, budżetach, harmonogramach, dokumentacji technicznej i wskazaniu, które wyniki RNM są podstawą nowego przedsięwzięcia. Każdy projekt musi mieć właściciela, datę uruchomienia, zakres badawczy lub rozwojowy i dowód, że nie jest zwykłym wdrożeniem u klienta. Zestawienie będzie przechowywać link do repozytorium, dokumentacji, umowy partnerskiej albo uchwały budżetowej.', 800, 790, ['Kontrola odróżni nowe B+R+I od sprzedaży, PR i rutynowych aktualizacji.']),
  },
];

function table(rows) {
  return [
    '| Podmiot konkurencyjny | Kraj siedziby | Produkt / rozwiązanie | Funkcjonalności | Korzyść / przewaga RNM |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.podmiot} | ${r.kraj} | ${r.produkt} | ${r.funkcjonalnosci} | ${r.korzysc} |`),
  ].join('\n');
}

function replaceBetween(source, startMarker, endMarker, body) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`markers missing: ${startMarker}`);
  return `${source.slice(0, start + startMarker.length)}\n\n${body}\n\n${source.slice(end)}`;
}

function paramBlock(p, index) {
  return `### Parametr ${index}

| Pole | Wartość |
|---|---|
| Nazwa parametru | ${p.name} |
| Wartość bazowa (z jednostką miary) | ${p.base} |
| Rok bazowy | ${p.baseYear} |
| Wartość docelowa (z jednostką miary) | ${p.target} |
| Rok docelowy | ${p.targetYear} |
| Metoda oszacowania wartości docelowej | ${p.method} |
| Sposób monitorowania / weryfikacji osiągnięcia zaplanowanych wartości docelowych | ${p.verify} |`;
}

let md = readFileSync(SRC, 'utf8');
md = replaceBetween(md, '## Oferta konkurencji wewnątrz UE', '## Oferta konkurencji spoza UE', table(EU));
md = replaceBetween(md, '## Oferta konkurencji spoza UE', '## Rynek docelowy dla innowacji produktowej', table(NON_EU));

const paramTitle = '## Parametry opisujące znaczący potencjał gospodarczy innowacji w wymiarze rynku wewnętrznego UE';
const paramStart = md.indexOf(paramTitle);
if (paramStart < 0) throw new Error('parameter section missing');
md = `${md.slice(0, paramStart + paramTitle.length)}\n\n${PARAMS.map((p, i) => paramBlock(p, i + 1)).join('\n\n')}\n`;

writeFileSync(SRC, md);
console.log(JSON.stringify({ ok: true, file: SRC, eu: EU.length, nonEu: NON_EU.length, params: PARAMS.length }, null, 2));
