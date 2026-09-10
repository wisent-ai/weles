// What repair_competition_2_3_wsession.mjs writes: the 1.4 competitors, and the 2.3 competition
// rows and parameters parsed out of the application's markdown source.
import { readFileSync } from 'node:fs';

export const SOURCE_23 = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_2.3_rynek_i_potencjal.md';

export const competitors14 = [
  { name: 'Synerise S.A.', nip: '6793093292', desc: 'Synerise S.A. jest polskim konkurentem w obszarze zastosowań sztucznej inteligencji dla przedsiębiorstw, w szczególności analizy danych behawioralnych, personalizacji, predykcji zachowań użytkowników i automatyzacji decyzji biznesowych. Firma rozwija platformę AI przetwarzającą sygnały behawioralne w czasie rzeczywistym oraz rozwiązania oparte na modelach predykcyjnych i rekomendacyjnych. Konkurencja wobec Wisent dotyczy rynku europejskich odbiorców technologii AI dla biznesu oraz pozycji krajowego dostawcy zaawansowanego oprogramowania AI. Różnica polega na tym, że Synerise koncentruje się na warstwie zastosowań biznesowych i danych behawioralnych, natomiast projekt Wisent dotyczy bazowej architektury modeli generatywnych RNM, w której sterowalność i audytowalność wynikają z konstrukcji reprezentacji wewnętrznych modelu.' },
  { name: 'Mistral AI', nip: '0000000000', desc: 'Mistral AI jest europejskim konkurentem w obszarze dużych modeli językowych, modeli otwartych wag i rozwiązań AI dla przedsiębiorstw. Firma rozwija klasyczne modele transformerowe oraz narzędzia wdrażania modeli i agentów AI, konkurując o tych samych europejskich odbiorców technologii generatywnej. Przewagą Mistral jest skala finansowania, rozpoznawalność i istniejąca dystrybucja rynkowa. Przewaga Wisent polega na innym poziomie innowacji: RNM nie są kolejnym transformerem, lecz architekturą projektowaną tak, aby kompetencje, zachowania i polityki bezpieczeństwa były zapisane jako stabilne reprezentacje możliwe do diagnozy i sterowania. Wisent oferuje możliwość modyfikacji zachowania modelu bez ponownego trenowania całej architektury, większą audytowalność i lepsze dopasowanie do wymogów regulowanych sektorów UE.' },
  { name: 'Goodfire AI', nip: '0000000000', desc: 'Goodfire AI jest jednym z najbliższych konkurentów technologicznych Wisent. Działa w obszarze interpretowalności i inżynierii reprezentacji modeli AI, rozwijając narzędzia pozwalające rozumieć i projektować zachowanie zaawansowanych modeli przez analizę ich reprezentacji wewnętrznych. Konkurencja dotyczy warstwy kontroli, diagnostyki i bezpieczeństwa modeli. Przewagą Goodfire jest silne pozycjonowanie w interpretowalności i koncentracja na narzędziach dla zaawansowanych systemów AI. Przewaga Wisent polega na tym, że projekt RNM nie ogranicza się do analizy lub sterowania istniejącymi modelami po treningu, lecz rozwija architekturę, w której reprezentacje są stabilizowane i separowane już w czasie treningu. Audytowalność i możliwość modyfikacji zachowania modelu stają się cechą modelu, nie wyłącznie zewnętrznym narzędziem diagnostycznym.' },
  { name: 'Anthropic', nip: '0000000000', desc: 'Anthropic jest jednym z głównych konkurentów Wisent w segmencie bezpiecznych modeli generatywnych dla przedsiębiorstw. Firma rozwija rodzinę modeli Claude i pozycjonuje się jako podmiot budujący niezawodne oraz sterowalne systemy AI. Podejście Constitutional AI kształtuje zachowanie modelu przez zestaw zasad używanych w procesie treningu i dostrajania, co stanowi konkurencyjne rozwiązanie wobec potrzeby kontroli zachowania modeli. Przewagą Anthropic jest marka, jakość modeli i zaufanie klientów enterprise. Przewaga Wisent polega na kontroli na poziomie geometrii reprezentacji wewnętrznych, nie wyłącznie przez reguły, polityki lub zamknięty proces dostawcy.' },
  { name: 'Gray Swan AI', aliases: ['Gray Swan AI', 'Greyswan AI'], nip: '0000000000', desc: 'Gray Swan AI jest konkurentem Wisent w obszarze bezpieczeństwa, red-teamingu oraz ewaluacji modeli sztucznej inteligencji. Firma rozwija platformę do adversarial evaluation, testowania podatności modeli i agentów AI oraz ochrony wdrożeń produkcyjnych przed atakami takimi jak jailbreaki, prompt injection czy niepożądane wyjścia modelu. Rozwiązania kieruje do laboratoriów frontier AI i przedsiębiorstw wdrażających systemy AI w środowiskach o wysokich wymaganiach bezpieczeństwa. Przewagą Gray Swan jest pozycja w testowaniu bezpieczeństwa i ochronie runtime. Przewaga Wisent polega na przesunięciu kontroli głębiej, z warstwy zewnętrznego testowania i filtrowania na poziom samej architektury modelu.' },
];

const md23 = readFileSync(SOURCE_23, 'utf8');
const clean = (s) => String(s || '').replace(/\s*<!--[\s\S]*?-->\s*/g, ' ').replace(/\s+/g, ' ').trim();

function between(start, end) {
  const after = md23.split(start)[1];
  if (after === undefined) throw new Error(`source marker not found: ${start}`);
  return end ? after.split(end)[0] : after;
}

function tableRows(block, expectedCells) {
  return block.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => clean(cell)))
    .filter((cells) => cells.length >= expectedCells && !/Podmiot konkurencyjny|Pole/.test(cells[0]));
}

function parseCompetitionRows(start, end) {
  return tableRows(between(start, end), 5).map((cells) => ({
    producer: cells[0],
    product: cells[2],
    functions: cells[3],
    advantage: cells[4],
  }));
}

function parseParameters() {
  const block = between('## Parametry opisujące znaczący potencjał gospodarczy innowacji w wymiarze rynku wewnętrznego UE', '## Podsumowanie zmian');
  return block.split(/^### Parametr \d+\s*$/m).slice(1).map((part) => {
    const map = new Map();
    for (const cells of tableRows(part, 2)) map.set(cells[0], cells[1]);
    return {
      name: map.get('Nazwa parametru'),
      baseValue: map.get('Wartość bazowa (z jednostką miary)'),
      baseYear: map.get('Rok bazowy'),
      targetValue: map.get('Wartość docelowa (z jednostką miary)'),
      targetYear: map.get('Rok docelowy'),
      estimate: map.get('Metoda oszacowania wartości docelowej'),
      verify: map.get('Sposób monitorowania / weryfikacji osiągnięcia zaplanowanych wartości docelowych'),
    };
  }).filter((row) => row.name && row.targetValue && row.targetYear);
}

export const euCompetition = parseCompetitionRows('## Oferta konkurencji wewnątrz UE', '## Oferta konkurencji spoza UE');
export const nonEuCompetition = parseCompetitionRows('## Oferta konkurencji spoza UE', '## Rynek docelowy');
export const parameters23 = parseParameters();
