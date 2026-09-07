/**
 * Declared engagement, through the built product.
 *
 * Every assertion here runs the compiled module the API server and the Stado
 * runner import — dist/worker/dispatch.js — and the real
 * src/trajectories/generic/saved_task.mjs as a spawned child, exactly as the
 * worker spawns it. Nothing is re-implemented locally, because the contract
 * being defended is what a caller gets, not what this file can compute.
 *
 * The declaration under test is an isolated root under ~/.stado/work, so no
 * assertion depends on the checked-in declaration staying the size it is
 * today, and nothing reaches a real account, vault or browser.
 *
 * Run: node --test tests/engagement
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const DISPATCH = join(REPO, 'dist/worker/dispatch.js');
const ENGAGEMENTS = join(REPO, 'dist/worker/engagements.js');
const SAVED_TASK = join(REPO, 'src/trajectories/generic/saved_task.mjs');
const DECLARATION = 'src/worker/deploy/weles-engagement-declaration.json';
const SAVED_TASK_PATH = 'src/trajectories/generic/saved_task.mjs';

const { paramsToEnv, resolveTrajectory } = await import(DISPATCH);
const { loadDeclaredEngagements } = await import(ENGAGEMENTS);

/**
 * A checkout with its own declaration and its own reviewed trajectory. The
 * trajectory writes down the env it was given, which is the only way to prove
 * from outside that the declared file is what actually ran.
 */
function isolatedRoot(engagements, { trajectory = true } = {}) {
  const scratch = join(homedir(), '.stado/work/weles-engagement-tests');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'root-'));
  mkdirSync(join(root, 'src/worker/deploy'), { recursive: true });
  mkdirSync(join(root, 'src/trajectories/fixture'), { recursive: true });
  writeFileSync(
    join(root, DECLARATION),
    `${JSON.stringify({ schema: 'wisent.weles-engagement-declaration.v1', engagements }, null, 2)}\n`,
  );
  if (trajectory) {
    writeFileSync(
      join(root, 'src/trajectories/fixture/like.mjs'),
      [
        'import { writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'writeFileSync(join(process.env.WELES_REPO, "replayed.json"), JSON.stringify({',
        '  engagement: process.env.GENERIC_ENGAGEMENT ?? null,',
        '  platform: process.env.PLATFORM ?? null,',
        '  verb: process.env.VERB ?? null,',
        '  target_url: process.env.TARGET_URL ?? null,',
        '}));',
      ].join('\n') + '\n',
    );
  }
  return root;
}

const FIXTURE = [{
  engagement: 'fixture.like',
  platform: 'fixture',
  verb: 'like',
  trajectory: 'src/trajectories/fixture/like.mjs',
}];

/** paramsToEnv reads the declaration of the checkout WELES_REPO names. */
function admit(root, params) {
  const previous = process.env.WELES_REPO;
  process.env.WELES_REPO = root;
  try {
    return paramsToEnv(params, 'generic_saved_task', SAVED_TASK_PATH);
  } finally {
    if (previous === undefined) delete process.env.WELES_REPO;
    else process.env.WELES_REPO = previous;
  }
}

test('a declared engagement is admitted and replays the reviewed trajectory it names', () => {
  const root = isolatedRoot(FIXTURE);
  try {
    assert.equal(resolveTrajectory('generic_saved_task'), SAVED_TASK_PATH);
    const env = admit(root, { engagement: 'fixture.like', target_url: 'https://example.com/post/1' });
    assert.equal(env.GENERIC_ENGAGEMENT, 'fixture.like');
    assert.equal(env.GENERIC_ENGAGEMENT_TRAJECTORY, 'src/trajectories/fixture/like.mjs');
    assert.equal(env.PLATFORM, 'fixture');
    assert.equal(env.VERB, 'like');

    // The real child the worker spawns, with the env admission produced.
    const run = spawnSync(process.execPath, [SAVED_TASK], {
      encoding: 'utf8',
      env: { ...process.env, ...env, WELES_REPO: root, NODE_OPTIONS: '' },
    });
    assert.equal(run.status, 0, `saved_task refused a declared engagement: ${run.stderr}`);
    assert.match(run.stdout, /\[saved-task\] engagement fixture\.like -> src\/trajectories\/fixture\/like\.mjs/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'replayed.json'), 'utf8')), {
      engagement: 'fixture.like',
      platform: 'fixture',
      verb: 'like',
      target_url: 'https://example.com/post/1',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an undeclared engagement is refused at admission, before anything is spawned', () => {
  const root = isolatedRoot(FIXTURE);
  try {
    assert.throws(
      () => admit(root, { engagement: 'fixture.smash', target_url: 'https://example.com/post/1' }),
      {
        message: 'engagement fixture.smash is not declared in'
          + ' src/worker/deploy/weles-engagement-declaration.json',
      },
    );
    // The verb it replaced is not a second way in.
    assert.equal(resolveTrajectory('twitter_like'), null);
    assert.equal(resolveTrajectory('reddit_upvote'), null);
    assert.equal(resolveTrajectory('github_star'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a declaration naming a missing reviewed trajectory is refused when it is loaded', () => {
  const root = isolatedRoot(FIXTURE, { trajectory: false });
  try {
    assert.throws(() => loadDeclaredEngagements(root), {
      message: 'declared engagement fixture.like names a missing reviewed trajectory:'
        + ' src/trajectories/fixture/like.mjs',
    });
    // And nothing is admitted from that checkout either: the declaration is
    // refused whole, so no engagement in it becomes a run.
    assert.throws(() => admit(root, { engagement: 'fixture.like' }), {
      message: 'declared engagement fixture.like names a missing reviewed trajectory:'
        + ' src/trajectories/fixture/like.mjs',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the checked-in declaration is the one this build admits', () => {
  const declared = loadDeclaredEngagements(REPO);
  const allowlist = readFileSync(join(REPO, 'src/worker/deploy/weles-action-allowlist.txt'), 'utf8')
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const [name, engagement] of declared) {
    assert.equal(name, `${engagement.platform}.${engagement.verb}`);
    // The point of the capability: a declared engagement is not an action.
    assert.equal(
      allowlist.includes(`${engagement.platform}_${engagement.verb}`),
      false,
      `${name} is still an admitted action, so the verb it replaced was not removed`,
    );
    assert.equal(resolveTrajectory(`${engagement.platform}_${engagement.verb}`), null);
  }
});
