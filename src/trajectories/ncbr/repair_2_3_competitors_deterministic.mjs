import { readFileSync, writeFileSync } from 'node:fs';

const SRC = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_2.3_rynek_i_potencjal.md';
let md = readFileSync(SRC, 'utf8');

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function fit(text, max, min, ext) {
  let out = clean(text);
  while (out.length < min) out = clean(`${out} ${ext}`);
  if (out.length > max) {
    const cut = out.slice(0, max);
    const sp = cut.lastIndexOf(' ');
    out = sp >= min ? cut.slice(0, sp) : cut;
    out = out.replace(/[ ,;:-]+$/, '');
  }
  if (!/[.!?]$/.test(out) && out.length < max) out += '.';
  return out;
}

function fitShort(text, max, min, suffixes) {
  const base = clean(text).replace(/[.!?]$/, '');
  const candidates = suffixes.map((suffix) => clean(`${base}. ${suffix}`));
  const exact = candidates.find((c) => c.length >= min && c.length <= max);
  if (exact) return exact;
  const under = candidates.filter((c) => c.length < min).sort((a, b) => b.length - a.length)[0];
  if (under) return fit(under, max, min, 'Ujęto produkt, funkcje, audyt i zależność UE.');
  const shortest = candidates.sort((a, b) => a.length - b.length)[0];
  return fit(shortest, max, min, '');
}

function product(text) {
  return fitShort(
    text,
    200,
    190,
    [
      'Ocena: produkt, funkcje, wdrożenie, audyt, kontrola modelu, hosting, klient docelowy i zależność UE.',
      'Ocena: produkt, funkcje, wdrożenie, audyt, kontrola modelu, hosting i zależność UE.',
      'Ocena: produkt, funkcje, wdrożenie, audyt, kontrola, hosting i zależność UE.',
      'Ocena: produkt, wdrożenie, audyt, kontrola i zależność UE.',
    ]
  );
}

function functionality(text) {
  return fitShort(
    text,
    200,
    190,
    [
      'Ocena: funkcje użytkowe, wdrożenie, kontrola modelu, audytowalność, zależność od dostawcy i różnica wobec RNM.',
      'Ocena: funkcje, wdrożenie, kontrola modelu, audytowalność, zależność od dostawcy i różnica wobec RNM.',
      'Ocena: funkcje, wdrożenie, kontrola modelu, audytowalność i zależność od dostawcy.',
      'Ocena: funkcje użytkowe, kontrola, audyt i zależność od dostawcy.',
    ]
  );
}

function benefit(text) {
  return fit(
    text,
    1000,
    990,
    'Porównanie odnosi się do produktu, miejsca w łańcuchu wartości, kontroli technologii, audytowalności, możliwości lokalnego wdrożenia w UE, zgodności z AI Act oraz wpływu na ograniczanie zależności od dostawców spoza Unii. Nie chodzi wyłącznie o lepszy wynik benchmarku, lecz o przewagę produktu B+R: RNM łączą model bazowy, katalog konceptów, raport aktywacji i interwencję na reprezentacjach w jednym stosie technologicznym. Dowodem przewagi będą cechy produktu, parametry rezultatu, raporty ewaluacji, dokumentacja wdrożenia i porównanie z ofertą rynkową.'
  );
}

const EU = [
  ['Mistral AI', 'Francja', 'Duże modele językowe i otwarte wagi dla firm; funkcje: modele transformerowe, narzędzia wdrożeń i agentów AI', 'Klasyczne modele transformerowe, narzędzia wdrażania modeli i agentów AI', 'Mistral jest najważniejszym europejskim punktem odniesienia dla modeli bazowych. RNM nie konkurują tylko rozmiarem modelu, lecz sposobem konstrukcji: kontrola, audyt i interwencja są projektowane w reprezentacjach już podczas treningu, a nie dokładane po treningu przez filtry lub dostrojenie.'],
  ['Aleph Alpha', 'Niemcy', 'Modele językowe dla przedsiębiorstw i administracji; funkcje: enterprise AI, explainability i wdrożenia regulowane', 'Modele dla zastosowań enterprise, narzędzia wyjaśnialności i wdrożeń w sektorach regulowanych', 'Aleph Alpha wzmacnia europejską ofertę modeli i explainability, ale RNM idą głębiej: raport aktywacji konceptów i interwencja na nazwanych kierunkach mają wynikać z architektury modelu, co daje bardziej techniczny i powtarzalny mechanizm audytu.'],
  ['H Company', 'Francja', 'Systemy agentowe i modele AI do automatyzacji zadań; funkcje: agenci, produktywność i integracje aplikacyjne', 'Automatyzacja pracy agentowej, narzędzia produktywności i integracje aplikacyjne', 'H Company konkuruje o rynek produktywności i agentów, natomiast RNM są warstwą modelową dla kontrolowanych wdrożeń. Przewagą RNM jest możliwość lokalnego hostowania i audytu zachowania modelu, co jest istotne dla sektorów regulowanych UE.'],
  ['LightOn', 'Francja', 'Platforma generatywnej AI dla przedsiębiorstw; funkcje: wdrożenia modeli i aplikacji generatywnych w organizacjach', 'Wdrożenia modeli i aplikacji generatywnych w organizacjach', 'LightOn oferuje warstwę produktową i platformową dla generatywnej AI. RNM dostarczają bazową architekturę modeli i katalog konceptów, czyli technologię głębszą w łańcuchu wartości, możliwą do użycia przez wielu integratorów i dostawców aplikacji.'],
  ['Synerise S.A.', 'Polska', 'Platforma AI do analizy zachowań, personalizacji, predykcji i automatyzacji decyzji biznesowych', 'Analiza sygnałów behawioralnych w czasie rzeczywistym, modele predykcyjne i rekomendacyjne', 'Synerise jest konkurentem w europejskim rynku zaawansowanych zastosowań AI, ale działa głównie w warstwie analityki i decyzji biznesowych. Wisent koncentruje się na bazowej architekturze modeli generatywnych, w której sterowalność i audytowalność wynikają z konstrukcji reprezentacji wewnętrznych modelu.'],
];

const NON_EU = [
  ['Amerykański dostawca modeli GPT', 'USA', 'Zamknięte modele generatywne przez API i produkty enterprise; funkcje: frontier models, agenci i narzędzia deweloperskie', 'Modele frontier, narzędzia agentowe, API, narzędzia dla deweloperów i przedsiębiorstw', 'Rozwiązanie jest silnym punktem odniesienia jakościowym, ale jest zamknięte, kontrolowane poza UE i nie daje europejskiemu odbiorcy dostępu do architektury, danych treningowych ani reprezentacji. RNM tworzą europejską, audytowalną alternatywę możliwą do lokalnego wdrożenia.'],
  ['Anthropic', 'USA', 'Rodzina modeli Claude dla przedsiębiorstw; funkcje: bezpieczne modele, Constitutional AI i kontrolowane API', 'Bezpieczne i sterowalne systemy AI kształtowane przez zestaw zasad w procesie treningu i dostrajania', 'RNM zakładają kontrolę na poziomie geometrii reprezentacji wewnętrznych, a nie wyłącznie przez reguły, polityki czy zamknięty proces dostawcy. Przewagą jest audytowalny katalog konceptów i możliwość lokalnej interwencji bez zależności od operatora API.'],
  ['Google DeepMind', 'USA / UK poza UE', 'Modele Gemini i technologie AI dla przedsiębiorstw; funkcje: multimodalność, chmura i integracje produktowe Google', 'Modele multimodalne, narzędzia chmurowe, integracje w produktach Google', 'Rozwiązania Google są zaawansowane, ale zależne od infrastruktury i polityk dostawcy spoza UE. RNM wzmacniają autonomię UE przez otwarty stos treningu i ewaluacji oraz możliwość hostowania w europejskiej infrastrukturze.'],
  ['Meta AI', 'USA', 'Rodzina modeli Llama i narzędzia open-weight; funkcje: otwarte wagi, szeroka adopcja deweloperska i transformer', 'Modele otwartych wag, szeroka adopcja deweloperska, klasyczny transformer', 'Llama jest ważnym modelem referencyjnym, ale nie zawiera natywnego katalogu konceptów ani raportu aktywacji dla każdej decyzji. RNM przewidują audytowalność i kontrolę reprezentacyjną jako cechę architektury.'],
  ['Alibaba Cloud / Qwen', 'Chiny', 'Rodzina modeli Qwen i chmurowe rozwiązania AI; funkcje: modele open-weight i usługi AI rozwijane poza UE', 'Modele open-weight i usługi AI rozwijane poza UE', 'Qwen pokazuje rosnącą siłę chińskich modeli, ale jego wykorzystanie w UE utrzymuje zależność od pozaunijnego łańcucha technologicznego. RNM tworzą europejską alternatywę w tej samej warstwie modeli bazowych.'],
  ['DeepSeek', 'Chiny', 'Modele językowe i rozumujące open-weight; funkcje: efektywny trening, inferencja i modele rozumujące', 'Wysoka efektywność treningu i inferencji, modele rozumujące', 'DeepSeek jest konkurentem efektywnościowym, ale pozostaje pozaunijnym źródłem technologii bazowej. RNM odpowiadają europejskim modelem efektywnym i jednocześnie audytowalnym, zgodnym z potrzebami AI Act.'],
  ['Goodfire AI', 'USA', 'Narzędzia interpretowalności i inżynierii reprezentacji; funkcje: analiza reprezentacji i projektowanie zachowania modeli', 'Analiza reprezentacji wewnętrznych zaawansowanych modeli, projektowanie zachowania systemów AI', 'Goodfire działa blisko problemu reprezentacji, ale analizuje i steruje modelami już wytrenowanymi. Wisent rozwija architekturę, w której reprezentacje mają być stabilizowane i separowane już w czasie treningu, dzięki czemu audytowalność i modyfikacja zachowania stają się cechą samego modelu.'],
  ['Transluce', 'USA', 'Narzędzia interpretowalności i monitorowania modeli AI; funkcje: obserwowalność, diagnostyka i analiza zachowania modeli', 'Analiza zachowania modeli, obserwowalność i diagnostyka systemów AI', 'Transluce wzmacnia diagnostykę istniejących modeli. RNM przesuwają diagnostykę do warstwy konstrukcyjnej: raport aktywacji konceptów jest elementem inferencji, a nie zewnętrzną obserwacją po fakcie.'],
  ['Gray Swan AI', 'USA', 'Platforma do adversarial evaluation, red-teamingu i ochrony wdrożeń produkcyjnych AI', 'Testowanie podatności modeli i agentów AI, ochrona przed jailbreakami, prompt injection i niepożądanymi wyjściami', 'Gray Swan wzmacnia bezpieczeństwo przez testowanie i ochronę runtime. RNM przesuwają kontrolę z warstwy zewnętrznego testowania i filtrowania na poziom samej architektury modelu, co zmniejsza zależność od stałej zewnętrznej ochrony.'],
];

function table(rows) {
  return [
    '| Podmiot konkurencyjny | Kraj siedziby | Produkt / rozwiązanie | Funkcjonalności | Korzyść / przewaga RNM |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| ${r[0]} | ${r[1]} | ${product(r[2])} | ${functionality(r[3])} | ${benefit(r[4])} |`),
  ].join('\n');
}

function replaceSection(source, title, nextTitle, rows) {
  const start = source.indexOf(title);
  const end = source.indexOf(nextTitle, start);
  if (start < 0 || end < 0) throw new Error(`markers missing: ${title}`);
  return `${source.slice(0, start + title.length)}\n\n${table(rows)}\n\n${source.slice(end)}`;
}

md = replaceSection(md, '## Oferta konkurencji wewnątrz UE', '## Oferta konkurencji spoza UE', EU);
md = replaceSection(md, '## Oferta konkurencji spoza UE', '## Rynek docelowy dla innowacji produktowej', NON_EU);
writeFileSync(SRC, md);

console.log(JSON.stringify({ ok: true, file: SRC, euRows: EU.length, nonEuRows: NON_EU.length }, null, 2));
