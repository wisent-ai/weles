// Real Chromium, the shipped page diagnostics, a real typed password: the
// instrumentation log must say that a field was written and how long the
// value was, and must hold neither the value nor the keys that typed it.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { evidenceFor } from '../security/evidence.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = await evidenceFor('input-recorder');
const scripts = ['property_trap.js', 'input_recorder.js'].map((name) =>
  join(root, 'src/diagnostics/page', name),
);
const required = (name) => {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required: it names the real Chromium the journey types into`);
  return value;
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

let failure;
let browser;
try {
  const executablePath = required('WELES_TEST_CHROMIUM');
  evidence.report.chromium = { path: executablePath, sha256: hash(await readFile(executablePath)) };
  evidence.report.source_digests = {};
  for (const script of scripts) evidence.report.source_digests[script] = hash(await readFile(script));

  browser = await chromium.launch({ executablePath });
  const context = await browser.newContext();
  for (const script of scripts) await context.addInitScript({ path: script });
  const page = await context.newPage();
  // The form is a page the browser navigates to, as a run's pages are:
  // setContent rewrites the open document, and document.open() erases the
  // listeners the recorder put on it (HTML, "document open steps"), so a
  // form set that way is typed into with no recorder listening. The address
  // is under the reserved .invalid domain and answered locally.
  const formPage = 'https://input-recorder.invalid/';
  await page.route(formPage, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><form><input id="user" type="text"><input id="secret" type="password"></form>',
    }),
  );
  await page.goto(formPage);

  // A value no page could hold by chance, typed key by key as a person would.
  const secret = randomUUID();
  await page.click('#secret');
  await page.keyboard.type(secret);
  // property_trap.js's flush() answers the log as JSON text.
  const written = await page.evaluate(() => {
    const api = globalThis[Symbol.for('weles.inst')];
    if (!api || typeof api.flush !== 'function') throw new Error('weles.inst.flush is unavailable');
    return api.flush();
  });
  const log = JSON.parse(written);
  assert.ok(Array.isArray(log), 'the instrumentation log is a list of entries');
  evidence.report.log_entries = log.length;

  // An entry's fields may be kept as JSON text inside the entry, so a key is
  // looked for written plainly and written escaped.
  assert.ok(!written.includes(secret), 'the typed password appears in the instrumentation log');
  for (const character of new Set(secret)) {
    for (const form of [`"key":"${character}"`, `\\"key\\":\\"${character}\\"`]) {
      assert.ok(!written.includes(form), `the key that typed ${JSON.stringify(character)} is recorded`);
    }
  }
  assert.ok(written.includes('input_event'), 'the recorder logged no field write at all, so it proved nothing');
  assert.ok(
    written.includes(`len":${secret.length}`) || written.includes(`len\\":${secret.length}`),
    `the recorded field write does not state the value's length ${secret.length}`,
  );
  evidence.report.status = 'passed';
} catch (cause) {
  failure = cause;
  evidence.report.status = 'failed';
  evidence.report.error = cause.stack;
} finally {
  if (browser) {
    try {
      await browser.close();
    } catch (cause) {
      evidence.report.status = 'failed';
      evidence.report.cleanup_error = cause.stack;
      failure = failure ? new AggregateError([failure, cause], 'journey and browser close failed') : cause;
    }
  }
  try {
    await evidence.finish();
  } catch (cause) {
    failure = failure ? new AggregateError([failure, cause], 'journey and evidence publication failed') : cause;
  }
}
if (failure) throw failure;
