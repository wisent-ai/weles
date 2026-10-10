import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DOCUMENT_REPLACED,
  readAcrossNavigation,
} from '../../src/trajectories/_shared/page/navigation/read.mjs';
import {
  pageSettled,
  submitAnswered,
} from '../../src/trajectories/_shared/page/settled.mjs';

// Requires managed Weles placement; no local standalone browser or account.
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = join(root, 'build/real-tests/navigation-read', randomUUID());
mkdirSync(directory, { recursive: true });
const report = {
  command: [process.execPath, ...process.execArgv, ...process.argv],
  source_revision: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
  host: hostname(),
  status: 'blocked',
  cases: [],
  recordings: join(directory, 'recordings'),
  scope: 'managed_browser_document_reads_only',
};
const save = () =>
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report));
process.once('exit', (code) => {
  report.exit_status = code;
  save();
});
save();
await test('document replacement retries, terminal pages and unrelated script errors refuse', async () => {
  let session;
  try {
    assert.ok(
      !process.env.WELES_STANDALONE,
      'managed placement must remain enforced',
    );
    assert.ok(!process.env.ACCOUNT_ID, 'use an isolated profile');
    assert.ok(!process.env.ACTION_LOG_ID, 'do not attach to a worker run');
    process.env.WELES_RECORDINGS_ROOT = report.recordings;
    process.env.WELES_RUN_ID = randomUUID();
    const { WSession } = await import('../../dist/session/wsession.js');
    session = await WSession.start({
      label: 'navigation-read',
      operatorCdp: false,
      userDataDir: join(directory, 'profile'),
      record: true,
    });
    const page = session.page;
    report.status = 'failed';
    report.browser = await page.evaluate(() => navigator.userAgent);
    await page.setContent('<!doctype html><main>Initial document</main>');
    const snapshotListeners = () => ({
      navigation: page.listenerCount('framenavigated'),
      close: page.listenerCount('close'),
      crash: page.listenerCount('crash'),
    });
    const baseline = snapshotListeners();
    await assert.rejects(
      readAcrossNavigation(page, () =>
        page.evaluate(() => {
          throw new Error(
            'Execution context was destroyed: application exception',
          );
        }),
      ),
      (error) => {
        report.cases.push({
          operation: 'script_failure',
          error: { name: error.name, message: error.message, code: error.code },
        });
        return (
          error.message.includes('application exception') &&
          error.code === undefined
        );
      },
    );
    assert.deepEqual(snapshotListeners(), baseline);
    let started = Promise.withResolvers();
    await page.exposeBinding('navigationReadStarted', () => started.resolve());
    const beginRead = () =>
      readAcrossNavigation(page, () =>
        page.evaluate(
          () =>
            new Promise(() => {
              window.navigationReadStarted();
            }),
        ),
      );
    const reading = beginRead();
    await started.promise;
    await page.goto(
      'data:text/html,<!doctype html><main>Replacement document</main>',
      { waitUntil: 'commit' },
    );
    assert.equal(await reading, DOCUMENT_REPLACED);
    await pageSettled(page);
    assert.equal(
      await page.locator('main').textContent(),
      'Replacement document',
    );
    assert.deepEqual(snapshotListeners(), baseline);
    report.cases.push({
      operation: 'document_replacement',
      outcome: 'read_replacement',
      screenshot: await session.screenshot('replacement-document'),
    });
    const message = page.locator('#answer');
    const answered = submitAnswered(page, page.url(), message);
    await page.evaluate(() => {
      const answer = document.createElement('p');
      answer.id = 'answer';
      answer.textContent = 'The form answered';
      document.body.append(answer);
    });
    assert.equal(await answered, 'message');
    assert.deepEqual(snapshotListeners(), baseline);
    report.cases.push({ operation: 'form_message', outcome: 'message' });
    started = Promise.withResolvers();
    const closing = beginRead();
    const refusal = assert.rejects(closing, (error) => {
      report.cases.push({
        operation: 'close_during_read',
        error: {
          code: error.code,
          message: error.message,
          cause: error.cause?.message,
        },
      });
      return error.code === 'PAGE_CLOSED' && error.cause instanceof Error;
    });
    await started.promise;
    await page.close();
    await refusal;
    assert.deepEqual(snapshotListeners(), baseline);
    await assert.rejects(
      pageSettled(page),
      (error) => error.code === 'PAGE_CLOSED',
    );
    await assert.rejects(
      submitAnswered(page, page.url(), message),
      (error) => error.code === 'PAGE_CLOSED',
    );
    report.cases.push({
      operation: 'already_closed',
      outcome: 'terminal_refusal',
    });
    report.status = 'passed';
  } catch (error) {
    report.error = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
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
      console.log(`navigation-read report: ${join(directory, 'report.json')}`);
    }
  }
});
