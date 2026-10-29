// Real Chromium with the shipped page diagnostics, the built weles CLI and the
// built pointer helpers: pointer travel recorded by the page's input recorder
// is harvested by `weles pointer harvest` into WELES_RECORDINGS_ROOT, `show`
// reports it, a dump without an access log and a host without a trace are
// refused by name, and a move replays the trace onto the requested target.
// Every position is read from the page: the controls' boxes and the viewport.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { evidenceFor } from '../security/evidence.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = await evidenceFor('pointer-trace');
const scripts = ['property_trap.js', 'input_recorder.js'].map((name) =>
  join(root, 'src/diagnostics/page', name),
);
const required = (name) => {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required: it names the real Chromium the journey drives`);
  return value;
};
// Throwaway state lives in the checkout's ignored build directory.
const recordings = join(root, '.build', 'pointer-trace-journey');
const cli = (...args) => {
  const ran = spawnSync(process.execPath, [join(root, 'dist/cli.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, WELES_RECORDINGS_ROOT: recordings },
  });
  evidence.report.commands.push({ args, status: ran.status, stdout: ran.stdout, stderr: ran.stderr });
  return ran;
};
// A run succeeded when it started, no signal ended it and it exited zero
// (https://nodejs.org/api/child_process.html#child_processspawnsynccommand-args-options).
const succeeded = (ran) => !ran.error && ran.signal === null && !ran.status;
const flushed = async (page) =>
  JSON.parse(await page.evaluate(() => globalThis[Symbol.for('weles.inst')].flush()));
const corners = (box) => [
  { x: box.x, y: box.y },
  { x: box.x + box.width, y: box.y + box.height },
];

let failure;
let browser;
try {
  rmSync(recordings, { recursive: true, force: true });
  mkdirSync(recordings, { recursive: true });
  evidence.report.commands = [];

  browser = await chromium.launch({ executablePath: required('WELES_TEST_CHROMIUM') });
  const context = await browser.newContext();
  for (const script of scripts) await context.addInitScript({ path: script });
  const page = await context.newPage();
  // The controls are a page the browser navigates to, as a run's pages are:
  // setContent rewrites the open document, and document.open() erases the
  // listeners the recorder put on it (HTML, "document open steps"). The
  // address is under the reserved .invalid domain and answered locally.
  const controlsPage = 'https://pointer-trace.invalid/';
  await page.route(controlsPage, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><div style="height:300vh;padding:10vh 10vw"><button id="a">first</button><p>between</p><button id="b">second</button><p>after</p><button id="c">third</button></div>',
    }),
  );
  await page.goto(controlsPage);
  const boxes = await Promise.all(['#a', '#b', '#c'].map((id) => page.locator(id).boundingBox()));

  // Travel between controls, each ended by a press, as the recorder sees a
  // person's hand; then one wheel step of a viewport.
  for (const box of boxes) {
    for (const point of corners(box)) await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.up();
  }
  const viewport = await page.evaluate(() => ({ height: innerHeight, scrollX, scrollY }));
  await page.mouse.wheel(viewport.scrollX, viewport.height);
  // mouse.wheel returns before the page has handled the event
  // (https://playwright.dev/docs/api/class-mouse#mouse-wheel), and the page
  // scrolls only after its wheel listeners ran, so the log is read once the
  // page has moved from where it stood.
  await page.waitForFunction((before) => scrollY !== before, viewport.scrollY);
  const dump = join(recordings, 'operator.inst.json');
  writeFileSync(dump, JSON.stringify({ accesses: [{ url: page.url(), log: await flushed(page) }] }));
  const empty = join(recordings, 'automated.inst.json');
  writeFileSync(empty, JSON.stringify({ accesses: null }));

  const missing = cli('pointer', 'show', '--json');
  assert.ok(!succeeded(missing), 'show succeeded with no trace on the host');
  assert.match(missing.stderr, /no pointer trace at .*pointer-trace\.json/);

  const refused = cli('pointer', 'harvest', empty, '--json');
  assert.ok(!succeeded(refused), 'a dump without an access log was harvested');
  assert.match(refused.stderr, /holds no access log/);

  const harvested = cli('pointer', 'harvest', dump, '--json');
  assert.ok(succeeded(harvested), harvested.stderr);
  const answer = JSON.parse(harvested.stdout);
  assert.ok(answer.segments, 'the harvest kept no segment of travel');
  assert.ok(answer.wheel_steps, 'the harvest kept no wheel step');
  assert.ok(existsSync(join(recordings, 'pointer-trace.json')));

  const shown = cli('pointer', 'show', '--json');
  assert.ok(succeeded(shown), shown.stderr);
  assert.deepEqual(JSON.parse(shown.stdout).sources, [dump]);

  // A replayed move ends on the requested target: the first control's corner.
  process.env.WELES_RECORDINGS_ROOT = recordings;
  const { seedHumanTiming } = await import(join(root, 'dist/utils/motion/timing.js'));
  const { humanMove } = await import(join(root, 'dist/human/mouse.js'));
  seedHumanTiming(Date.now());
  const [target] = corners(boxes.findLast(Boolean));
  await humanMove(page, target.x, target.y);
  const moved = (await flushed(page))
    .filter((entry) => entry.o === 'Input' && entry.p === 'pointermove')
    .map((entry) => JSON.parse(entry.vs));
  const last = moved.findLast(Boolean);
  assert.deepEqual(last, target, `the replayed move ended at ${JSON.stringify(last)}`);
  evidence.report.replayed_points = moved.length;
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
      failure = failure ? new AggregateError([failure, cause], 'journey and browser close failed') : cause;
    }
  }
  rmSync(recordings, { recursive: true, force: true });
  try {
    await evidence.finish();
  } catch (cause) {
    failure = failure ? new AggregateError([failure, cause], 'journey and evidence publication failed') : cause;
  }
}
if (failure) throw failure;
