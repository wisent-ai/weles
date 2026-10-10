import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const reports = join(root, 'build/real-tests/ncbr-source-text');
mkdirSync(reports, { recursive: true });
const run = mkdtempSync(join(reports, 'run-'));
const report = {
  source_revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  command: [process.execPath, ...process.execArgv, ...process.argv],
  operations: [],
};
process.once('exit', (code) => {
  report.exit_status = code;
  writeFileSync(join(run, 'report.json'), JSON.stringify(report));
});

const market = 'wersja_B_2.3_rynek_i_potencjal.md';
const marketHeadings = [
  '## Oferta konkurencji wewnątrz UE',
  '## Oferta konkurencji spoza UE',
  '## Rynek docelowy dla innowacji produktowej',
  '## Parametry opisujące znaczący potencjał gospodarczy innowacji w wymiarze rynku wewnętrznego UE',
];
const cases = [
  {
    script: '2_2/repair_2_2_factor_rows_source.mjs',
    file: 'wersja_B_2.2_innowacyjnosc_i_zaleznosci.md',
    headings: [
      '## Podsumowanie wpływu prac B+R na ograniczanie lub zwalczanie zależności Unii',
      '## Powiązanie rezultatu prac B+R z łańcuchem wartości konkretnej technologii krytycznej',
    ],
    refusal: 'table markers not found',
    forbidden: 'Dodatkowo opis obejmuje zakres danych, częstotliwość pomiaru',
  },
  {
    script: '2_3/repair_2_3_competitors_deterministic.mjs',
    file: market, headings: marketHeadings,
    refusal: 'markers missing: ## Oferta konkurencji wewnątrz UE',
    forbidden: 'Ocena: produkt, funkcje',
  },
  {
    script: '2_3/repair_2_3_dense_source.mjs',
    file: market, headings: marketHeadings,
    refusal: 'markers missing: ## Oferta konkurencji wewnątrz UE',
    forbidden: 'To mierzy przewagę architektury, nie sam branding dostawcy.',
    preserved: 'Weryfikacja geograficzna opiera się na siedzibie kontrahenta z umowy i faktury, nie na lokalizacji użytkownika końcowego.',
  },
  {
    script: '2_4/repair_2_4_external_effects_source.mjs',
    file: 'wersja_B_2.4_efekty_zewnetrzne.md',
    headings: ['## Parametry opisujące dodatkowe efekty zewnętrzne innowacji'],
    refusal: 'parameter title not found',
    forbidden: 'Ujęto zakres, dowód, rynek i wyłączenia.',
  },
];

for (const fixture of cases) {
  await test(`source writer preserves prose and refuses unknown documents: ${fixture.script}`, () => {
    const directory = mkdtempSync(join(run, 'application-'));
    const path = join(directory, fixture.file);
    const invoke = (configured = true) => {
      const env = { ...process.env };
      delete env.NCBR_APPLICATION_TEXT_DIR;
      if (configured) env.NCBR_APPLICATION_TEXT_DIR = directory;
      const script = join('src/trajectories/ncbr/repair', fixture.script);
      const operation = { command: [process.execPath, script], configured };
      report.operations.push(operation);
      try {
        operation.stdout = execFileSync(process.execPath, [script], { cwd: root, env, encoding: 'utf8', stdio: 'pipe' });
        operation.outcome = 'completed';
      } catch (error) {
        operation.status = error.status;
        operation.signal = error.signal;
        operation.stdout = error.stdout?.toString();
        operation.stderr = error.stderr?.toString();
        operation.error = error.message;
        operation.outcome = 'refused';
        throw error;
      }
    };
    try {
      const before = `# Authored application\n\n${fixture.headings.join('\n\nOriginal section\n\n')}\n`;
      writeFileSync(path, before);
      assert.throws(() => invoke(false), (error) => String(error.stderr).includes('NCBR_APPLICATION_TEXT_DIR is not set'));
      assert.equal(readFileSync(path, 'utf8'), before);
      invoke();
      const written = readFileSync(path, 'utf8');
      assert.ok(written.startsWith('# Authored application\n\n'));
      assert.ok(!written.includes(fixture.forbidden), 'no automatically selected filler');
      if (fixture.preserved) assert.ok(written.includes(fixture.preserved), 'the full authored final clause survives');
      invoke();
      assert.equal(readFileSync(path, 'utf8'), written, 'generation does not accumulate duplicate prose');
      writeFileSync(join(run, fixture.script.replaceAll('/', '-') + '.md'), written);
      const unknown = '# Different document\n\nDo not replace this text.\n';
      writeFileSync(path, unknown);
      assert.throws(() => invoke(), (error) => String(error.stderr).includes(fixture.refusal));
      assert.equal(readFileSync(path, 'utf8'), unknown, 'refusal leaves the document unchanged');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
console.log(`source-text report: ${join(run, 'report.json')}`);
