// A real Chromium context records a HAR in Weles' mode while a page posts a
// form with a typed password; once the context has closed, the HAR holds the
// password, and after scrubHar, which the session's close runs, it holds it
// in no spelling. A HAR that is not a HAR is removed rather than published.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';
import { scrubHar } from '../../dist/session/wsession-helpers/har_scrub.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const reports = join(root, 'build/real-tests/capture');
mkdirSync(reports, { recursive: true });
const directory = mkdtempSync(join(reports, 'har-request-bodies-'));
const report = {
  source_revision: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
  command: [process.execPath, ...process.execArgv, ...process.argv],
  files: [],
};
process.once('exit', (code) => {
  report.exit_status = code;
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report));
});

const FORM =
  '<form method="post" action="/sign-in"><input type="password" name="secret"><button>Sign in</button></form>';

/** A page that answers GET with the form and its POST with a sign-in page. */
async function formServer() {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.setHeader('content-type', 'text/html');
      response.end(request.method === 'POST' ? '<p>signed in</p>' : FORM);
    });
  });
  // No port is named, so the system chooses a free one.
  await new Promise((listening) =>
    server.listen(undefined, 'localhost', listening),
  );
  const { address, family, port } = server.address();
  const host = family === 'IPv6' ? `[${address}]` : address;
  return { server, url: `http://${host}:${port}/` };
}

await test('a password a form posts is in the sealed HAR and in no spelling after scrubHar', async () => {
  const password = `typed ${randomUUID()}&+`;
  const { server, url } = await formServer();
  const har = join(directory, 'session.har');
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      recordHar: { path: har, content: 'embed', mode: 'full' },
    });
    const page = await context.newPage();
    await page.goto(url);
    await page.fill('input[type="password"]', password);
    await Promise.all([
      page.waitForResponse(
        (response) => response.request().method() === 'POST',
      ),
      page.click('button'),
    ]);
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
  const spellings = [
    password,
    encodeURIComponent(password),
    new URLSearchParams([['', password]]).toString().replace(/^=/, ''),
  ];
  const recorded = readFileSync(har, 'utf8');
  assert.ok(
    spellings.some((spelling) => recorded.includes(spelling)),
    'the HAR Playwright sealed carries the posted password',
  );
  scrubHar(har);
  const scrubbed = readFileSync(har, 'utf8');
  for (const spelling of spellings)
    assert.ok(!scrubbed.includes(spelling), spelling);
  const posts = JSON.parse(scrubbed).log.entries.filter(
    (entry) => entry.request.method === 'POST',
  );
  assert.ok(posts.length, 'the HAR keeps the POST entry');
  for (const post of posts)
    assert.match(post.request.postData.text, /withheld/);
  report.files.push(har);
});

await test('a HAR that cannot be read is removed rather than published', () => {
  const har = join(directory, 'unreadable.har');
  writeFileSync(har, 'not json');
  scrubHar(har);
  assert.ok(!existsSync(har));
});
