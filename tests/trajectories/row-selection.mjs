import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { rowShowingSource } from '../../src/trajectories/_shared/page/shows.mjs';

// Run on the Stado-selected dedicated Weles host, never in standalone mode.
// This exercises the actual reader inside a managed browser, not an NCBR edit.
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = join(root, 'build/real-tests/row-selection', randomUUID());
mkdirSync(directory, { recursive: true });
const report = {
  command: [process.execPath, ...process.execArgv, ...process.argv],
  source_revision: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root, encoding: 'utf8',
  }).trim(),
  host: hostname(),
  started_at: new Date().toISOString(),
  scope: 'managed_browser_table_reader_only',
  ncbr_edit: 'not_run',
  status: 'blocked',
  cases: [],
  screenshots: [],
  recordings: join(directory, 'recordings'),
};
const save = () => writeFileSync(join(directory, 'report.json'), JSON.stringify(report));
process.once('exit', (code) => {
  report.exit_status = code;
  report.finished_at = new Date().toISOString();
  save();
});
save();

const cases = [
  {
    name: 'exact match after unrelated row',
    rows: '<tr id="unrelated"><td>Other</td></tr><tr id="wanted"><td>Research output</td></tr>',
    wanted: 'Research output', expected: 'wanted',
  },
  {
    name: 'whitespace-normalized complete value',
    rows: '<tr id="wanted"><td>Research   output</td></tr>',
    wanted: ' Research\noutput ', expected: 'wanted',
  },
  {
    name: 'page-declared Unicode ellipsis',
    rows: '<tr id="wanted"><td>Research…</td></tr>',
    wanted: 'Research output', expected: 'wanted',
  },
  {
    name: 'page-declared three-dot ellipsis',
    rows: '<tr id="wanted"><td>Research...</td></tr>',
    wanted: 'Research output', expected: 'wanted',
  },
  {
    name: 'unmarked prefix is not a match',
    rows: '<tr id="unrelated"><td>Research</td></tr>',
    wanted: 'Research output', expected: null,
  },
  {
    name: 'duplicate matching cells within one row remain unique',
    rows: '<tr id="wanted"><td>Research output</td><td>Research output</td></tr>',
    wanted: 'Research output', expected: 'wanted',
  },
  {
    name: 'duplicate full names refuse selection',
    rows: '<tr><td>Research output</td></tr><tr><td>Research output</td></tr>',
    wanted: 'Research output', refused: true,
  },
  {
    name: 'shared displayed prefixes refuse selection',
    rows: '<tr><td>Research…</td></tr><tr><td>Research…</td></tr>',
    wanted: 'Research output', refused: true,
  },
  {
    name: 'exact and truncated candidates remain ambiguous',
    rows: '<tr><td>Research output</td></tr><tr><td>Research…</td></tr>',
    wanted: 'Research output', refused: true,
  },
];

await test('table row selection in the managed Weles browser', async () => {
  let session;
  try {
    assert.ok(!process.env.WELES_STANDALONE, 'Stado placement must remain enforced');
    assert.ok(!process.env.ACCOUNT_ID, 'use an isolated test process without an account');
    assert.ok(!process.env.ACTION_LOG_ID, 'do not attach this test to an existing worker run');
    const changed = execFileSync('git', ['status', '--porcelain', '--',
      'src/trajectories/_shared/page/shows.mjs', 'tests/trajectories/row-selection.mjs'], {
      cwd: root, encoding: 'utf8',
    });
    assert.equal(changed.trim(), '', 'commit the exercised reader and test before qualification');
    const sessionModule = new URL('../../dist/session/wsession.js', import.meta.url);
    report.session_module_sha256 = createHash('sha256')
      .update(readFileSync(sessionModule)).digest('hex');
    process.env.WELES_RECORDINGS_ROOT = report.recordings;
    process.env.WELES_RUN_ID = randomUUID();
    const { WSession } = await import(sessionModule.href);
    session = await WSession.start({
      label: 'row-selection', operatorCdp: false,
      userDataDir: join(directory, 'profile'), record: true,
    });
    report.status = 'failed';
    report.browser = await session.page.evaluate(() => navigator.userAgent);
    for (const fixture of cases) {
      const outcome = { name: fixture.name, status: 'running' };
      report.cases.push(outcome);
      await session.page.setContent(`<html><body><table><tbody>${fixture.rows}</tbody></table></body></html>`);
      const before = await session.page.content();
      if (fixture.refused) {
        await assert.rejects(
          session.page.evaluate(rowShowingSource, fixture.wanted),
          (error) => {
            outcome.error = error.message;
            return error.message.includes('row_source_ambiguous:');
          },
          fixture.name,
        );
      } else {
        const index = await session.page.evaluate(rowShowingSource, fixture.wanted);
        const observed = await session.page.evaluate((selected) => {
          const rows = Array.from(document.querySelectorAll('table tbody tr'));
          const row = rows[selected];
          return row ? row.id : null;
        }, index);
        outcome.observed = observed;
        assert.equal(observed, fixture.expected, fixture.name);
      }
      assert.equal(await session.page.content(), before, 'selection must not mutate the page');
      report.screenshots.push(await session.screenshot(fixture.name));
      outcome.status = 'passed';
      save();
    }
    report.status = 'passed';
  } catch (error) {
    report.error = { name: error.name, message: error.message, stack: error.stack };
    throw error;
  } finally {
    try {
      if (session) await session.close();
    } catch (error) {
      report.status = 'failed';
      report.close_error = { name: error.name, message: error.message };
      throw error;
    } finally {
      save();
      console.log(`row-selection report: ${join(directory, 'report.json')}`);
    }
  }
});
