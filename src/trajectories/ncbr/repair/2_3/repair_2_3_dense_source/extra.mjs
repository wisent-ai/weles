// The extra clauses each 2.3 entry may carry, and the fit that squeezes an entry into the
// application's field limits.

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

export const EXTRA = {
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

export function fit(label, text, max, min, clauses = []) {
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
