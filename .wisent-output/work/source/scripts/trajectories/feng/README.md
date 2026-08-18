# weles trajectoria: auto-wypełnianie wniosku FENG SMART / STEP

Otwiera generator PARP/NCBR w przeglądarce sterowanej przez weles, czeka na ręczne zalogowanie 2FA, potem wpisuje wartości z draftów lokalnych (`applications/feng-sciezka-smart/sprind-version/`) do odpowiednich pól formularza.

## Pliki w tym katalogu

- `parse_drafts.mjs` — parser markdownów. Skanuje katalog draftów za blokami `<!-- value name="X" -->Y<!-- /value -->` i emituje flat JSON na stdout. Pomija bloki w backtickach (dokumentacja konwencji) i bloki z nazwą `"..."`.
- `field_map.json` — mapowanie nazwy z draftu na selektor CSS w generatorze. Każda pozycja zawiera `selector`, `type` (`text`, `textarea`, `select`, `checkbox`, `radio`), opcjonalnie `option` dla `select`/`radio`. Wstępna wersja ma 400 wpisów z `selector: "TODO"` i typem inferowanym z wartości.
- `smart_wniosek_fill.mjs` — główna trajektoria weles. Otwiera generator, czeka maks. 20 minut na ręczne zalogowanie, iteruje po wartościach i dla każdego pola z mapowaniem wpisuje wartość przez humanizowane atomy (`humanFill`, `humanClickLocator`, `humanIdlePause`). Loguje liczby wypełnionych, pominiętych, błędów i pól bez mapowania.

## Workflow

### Krok 1 — regeneracja wartości po zmianie draftów

```
cd weles/scripts/trajectories/feng
node parse_drafts.mjs > .work/values.json
```

Sprawdź na stderr ile pól zostało zparsowanych i czy są duplikaty nazw między plikami.

### Krok 2 — discovery selektorów (jednorazowo plus aktualizacje)

PARP używa generatora bez publicznej dokumentacji selektorów, więc trzeba je zmapować empirycznie:

1. Otwórz generator w zwykłym Chrome, zaloguj się, otwórz wniosek do edycji.
2. Otwórz devtools w sekcji, w której jesteś (np. „Informacje ogólne o projekcie").
3. Dla każdego widocznego pola: kliknij inspector i zapisz selektor (preferowane atrybuty `id`, `name`, `data-field`, ewentualnie `[aria-label="..."]`).
4. Otwórz `field_map.json` i wstaw wartość w `selector`, ewentualnie zmień `type` lub dodaj `option`.

Selektory możesz dodawać partiami — trajektoria pomija pola gdzie `selector` zaczyna się od `TODO`.

### Krok 3 — uruchomienie trajektorii

```
cd weles
FENG_WNIOSEK_URL='https://lsi2.parp.gov.pl/wnioski/edit/12345' \
  node scripts/trajectories/feng/smart_wniosek_fill.mjs
```

Co się dzieje:

1. WSession startuje weles-patched Chromium z humanizowanymi atomami.
2. Trajektoria otwiera `lsi2.parp.gov.pl`.
3. Czekasz na keepera CDP-attached — przechodzisz przez login plus 2FA SMS samodzielnie. Trajektoria sprawdza co 5 sekund czy URL nie zawiera już `/login` (do 20 minut).
4. Jeśli `FENG_WNIOSEK_URL` ustawione, trajektoria nawiguje do konkretnego wniosku.
5. Iteruje po wartościach. Dla każdej z mapowaniem: czeka aż element jest widoczny, używa `humanFill` / `humanClickLocator` / `humanIdlePause`.
6. Loguje podsumowanie: wypełnione, pominięte (brak selektora), błędy, pola bez mapowania.
7. Sesja zostaje otwarta przez 1 godzinę żebyś mógł zweryfikować i poprawić ręcznie.

### Krok 4 — iteracja

Po pierwszym uruchomieniu zobaczysz w logach które pola wypełniły się poprawnie, gdzie były błędy i ile zostało jeszcze bez mapowania. Aktualizujesz `field_map.json` i odpalasz ponownie. Trajektoria jest idempotentna — pola które są już wypełnione zostaną nadpisane przez `humanFill` tym samym tekstem.

## Zmienne środowiskowe

- `PARP_GENERATOR_URL` — bazowy URL generatora. Domyślnie `https://lsi.parp.gov.pl/` (LSI dla SMART). Konsorcja NCBR są na `https://lsi2.ncbr.gov.pl/logowanie`. Dla naboru SMART dla MŚP używa się `https://lsi-fn.parp.gov.pl/`.
- `FENG_WNIOSEK_URL` — konkretny URL wniosku do edycji (po loginie).
- `FENG_VALUES` — ścieżka do zparsowanego JSON-a wartości. Bez tego parser uruchamiany jest na lecie.
- `FENG_FIELD_MAP` — ścieżka do `field_map.json` (domyślnie obok tego pliku).
- `PROXY_URL` — opcjonalny proxy dla WSession. PARP akceptuje europejskie IPv4 bez problemu, więc domyślnie direct egress.

## Ograniczenia

Trajektoria obsługuje proste typy pól (text, textarea, select, checkbox, radio). Nie obsługuje:

- Tabel HRF z dynamicznym dodawaniem wierszy (kamienie milowe, wydatki rzeczywiste). Te trzeba dodawać ręcznie lub rozszerzyć trajektorię o dedykowane handlery.
- Załączników (PNT-01, model finansowy, dokumenty IP). Upload plików wymaga osobnej logiki.
- Pól wyliczanych automatycznie (sumy w HRF, koszty pośrednie). Generator wypełnia je sam.
- Walidacji po stronie generatora (limity znaków, formaty dat). Trajektoria nie waliduje, polega na wartościach z draftu.

Dla SMART jako wniosku w pełni elektronicznego potrzebujesz po automatycznym wypełnieniu jeszcze ręcznie przejrzeć tabele HRF i załączniki, zanim klikniesz „Wyślij wniosek".

## Aktualizacja gdy generator PARP się zmieni

Jeśli PARP przerobi generator wniosków (zwykle raz na dwa lata po końcu starego naboru), selektory w `field_map.json` przestaną pasować. Wtedy aktualizujesz selektory dla pól, które się zmieniły. Trajektoria nie wymaga zmian — selektory są danymi.

Pól bez mapowania (`selector: "TODO"`) trajektoria pomija bez błędu, więc field_map może być stopniowo rozszerzany.
