/**
 * Declared observation, through the built product.
 *
 * Every assertion here runs the compiled module the API server and the Stado
 * runner import — dist/worker/dispatch.js — and the real
 * src/trajectories/generic/keeper_task.mjs as a spawned child, exactly as the
 * worker spawns it. Nothing is re-implemented locally, because the contract
 * being defended is what a caller gets, not what this file can compute.
 *
 * The declaration under test is an isolated root under ~/.stado/work, so no
 * assertion depends on the checked-in declaration staying the size it is
 * today, and nothing reaches a real account, vault or browser.
 *
 * Run: node --test tests/observation/declared-observation.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const DISPATCH = join(REPO, 'dist/worker/dispatch.js');
const OBSERVATIONS = join(REPO, 'dist/worker/observations.js');
const KEEPER_TASK = join(REPO, 'src/trajectories/generic/keeper_task.mjs');
const DECLARATION = 'src/worker/deploy/weles-observation-declaration.json';
const KEEPER_TASK_PATH = 'src/trajectories/generic/keeper_task.mjs';

const { paramsToEnv, resolveTrajectory } = await import(DISPATCH);
const { loadDeclaredObservations } = await import(OBSERVATIONS);

/**
 * A checkout with its own declaration and its own reviewed trajectory. The
 * trajectory writes down the env it was given, which is the only way to prove
 * from outside that the declared file is what actually ran, at the declared
 * origin, on the declared budget.
 */
function isolatedRoot(observations, { trajectory = true } = {}) {
  const scratch = join(homedir(), '.stado/work/weles-observation-tests');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'root-'));
  mkdirSync(join(root, 'src/worker/deploy'), { recursive: true });
  mkdirSync(join(root, 'src/trajectories/fixture'), { recursive: true });
  writeFileSync(
    join(root, DECLARATION),
    `${JSON.stringify({ schema: 'wisent.weles-observation-declaration.v1', observations }, null, 2)}\n`,
  );
  if (trajectory) {
    writeFileSync(
      join(root, 'src/trajectories/fixture/dwell.mjs'),
      [
        'import { writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'import { declaredObservation } from "../_shared/observation.mjs";',
        'writeFileSync(join(process.env.WELES_REPO, "observed.json"), JSON.stringify(declaredObservation()));',
      ].join('\n') + '\n',
    );
    // The reader the reviewed trajectories use is product source, so the
    // fixture imports the real one rather than a copy of its behavior.
    mkdirSync(join(root, 'src/trajectories/_shared'), { recursive: true });
    writeFileSync(
      join(root, 'src/trajectories/_shared/observation.mjs'),
      readFileSync(join(REPO, 'src/trajectories/_shared/observation.mjs')),
    );
  }
  return root;
}

const FIXTURE = [{
  observation: 'fixture.dwell',
  platform: 'fixture',
  verb: 'dwell',
  origin: 'https://fixture.example/r/{subreddit}/',
  reads: 'feed',
  dwell: { scrolls: 3, ms: [1500, 2500] },
  trajectory: 'src/trajectories/fixture/dwell.mjs',
}];

/** paramsToEnv reads the declaration of the checkout WELES_REPO names. */
function admit(root, params) {
  const previous = process.env.WELES_REPO;
  process.env.WELES_REPO = root;
  try {
    return paramsToEnv(params, 'generic_keeper_task', KEEPER_TASK_PATH);
  } finally {
    if (previous === undefined) delete process.env.WELES_REPO;
    else process.env.WELES_REPO = previous;
  }
}

test('a declared observation is admitted and runs the reviewed trajectory it names', () => {
  const root = isolatedRoot(FIXTURE);
  try {
    assert.equal(resolveTrajectory('generic_keeper_task'), KEEPER_TASK_PATH);
    const env = admit(root, { observation: 'fixture.dwell', subreddit: 'r/popular' });
    assert.equal(env.GENERIC_OBSERVATION, 'fixture.dwell');
    assert.equal(env.GENERIC_OBSERVATION_TRAJECTORY, 'src/trajectories/fixture/dwell.mjs');
    // The declared origin, with the placeholder the submission named filled in
    // and the leading r/ the caller typed stripped, is what the run reads.
    assert.equal(env.GENERIC_OBSERVATION_ORIGIN, 'https://fixture.example/r/popular/');
    assert.equal(env.GENERIC_OBSERVATION_READS, 'feed');
    assert.equal(env.GENERIC_OBSERVATION_SCROLLS, '3');
    assert.equal(env.GENERIC_OBSERVATION_DWELL_MS, '1500,2500');
    assert.equal(env.PLATFORM, 'fixture');
    assert.equal(env.VERB, 'dwell');

    // The real child the worker spawns, with the env admission produced.
    const run = spawnSync(process.execPath, [KEEPER_TASK], {
      encoding: 'utf8',
      env: { ...process.env, ...env, WELES_REPO: root, NODE_OPTIONS: '' },
    });
    assert.equal(run.status, 0, `keeper_task refused a declared observation: ${run.stderr}`);
    assert.match(run.stdout, /\[keeper-task\] observation fixture\.dwell -> src\/trajectories\/fixture\/dwell\.mjs/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'observed.json'), 'utf8')), {
      observation: 'fixture.dwell',
      platform: 'fixture',
      verb: 'dwell',
      origin: 'https://fixture.example/r/popular/',
      reads: 'feed',
      scrolls: 3,
      dwellMs: [1500, 2500],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an undeclared observation is refused at admission, before anything is spawned', () => {
  const root = isolatedRoot(FIXTURE);
  try {
    assert.throws(
      () => admit(root, { observation: 'fixture.doomscroll' }),
      {
        message: 'observation fixture.doomscroll is not declared in'
          + ' src/worker/deploy/weles-observation-declaration.json',
      },
    );
    // The verbs it replaced are not a second way in.
    assert.equal(resolveTrajectory('twitter_dwell'), null);
    assert.equal(resolveTrajectory('reddit_browse'), null);
    assert.equal(resolveTrajectory('github_search'), null);
    assert.equal(resolveTrajectory('linkedin_profile_view'), null);
    assert.equal(resolveTrajectory('instagram_notifications'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a declaration naming a missing reviewed trajectory is refused when it is loaded', () => {
  const root = isolatedRoot(FIXTURE, { trajectory: false });
  try {
    assert.throws(() => loadDeclaredObservations(root), {
      message: 'declared observation fixture.dwell names a missing reviewed trajectory:'
        + ' src/trajectories/fixture/dwell.mjs',
    });
    // And nothing is admitted from that checkout either: the declaration is
    // refused whole, so no observation in it becomes a run.
    assert.throws(() => admit(root, { observation: 'fixture.dwell', subreddit: 'popular' }), {
      message: 'declared observation fixture.dwell names a missing reviewed trajectory:'
        + ' src/trajectories/fixture/dwell.mjs',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a declaration whose origin cannot show what it must read is refused', () => {
  // The reality check on the declaration itself: an origin carrying no query
  // cannot produce search results however the row is labelled, and this is
  // exactly why discord_search and discord_profile_view have no declaration —
  // both resolved to https://discord.com/channels/@me.
  const searchWithoutQuery = isolatedRoot([{
    ...FIXTURE[0],
    observation: 'fixture.search',
    verb: 'search',
    reads: 'search_results',
    origin: 'https://fixture.example/channels/@me',
  }]);
  try {
    assert.throws(() => loadDeclaredObservations(searchWithoutQuery), {
      message: 'declared observation fixture.search reads search_results, so its origin must carry {query}',
    });
  } finally {
    rmSync(searchWithoutQuery, { recursive: true, force: true });
  }

  const unknownPlaceholder = isolatedRoot([{
    ...FIXTURE[0],
    origin: 'https://fixture.example/{whatever}/',
  }]);
  try {
    assert.throws(() => loadDeclaredObservations(unknownPlaceholder), {
      message: 'declared observation fixture.dwell names the unknown origin placeholder {whatever}',
    });
  } finally {
    rmSync(unknownPlaceholder, { recursive: true, force: true });
  }

  const brokenBudget = isolatedRoot([{ ...FIXTURE[0], dwell: { scrolls: 3, ms: [2500, 1500] } }]);
  try {
    assert.throws(() => loadDeclaredObservations(brokenBudget), {
      message: 'declared observation fixture.dwell must declare a dwell budget of whole scrolls'
        + ' and an ascending ms range',
    });
  } finally {
    rmSync(brokenBudget, { recursive: true, force: true });
  }
});

test('a submission that names the origin or the budget itself is refused', () => {
  const root = isolatedRoot(FIXTURE);
  try {
    // The declaration owns what the run reads and how long it stays, so a
    // submission carrying either is two answers to the same question.
    for (const key of ['url', 'objective', 'target_url', 'target_user', 'search_query', 'posts_to_browse']) {
      assert.throws(
        () => admit(root, { observation: 'fixture.dwell', subreddit: 'popular', [key]: 'x' }),
        { message: `generic_keeper_task takes a declared observation or ${key}, not both` },
      );
    }
    // A placeholder the submission does not name is refused rather than
    // navigated to as the literal {subreddit}.
    assert.throws(() => admit(root, { observation: 'fixture.dwell' }), {
      message: 'observation fixture.dwell reads feed and needs subreddit',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the keeper task still runs its own objective when no observation is named', () => {
  const root = isolatedRoot(FIXTURE);
  try {
    // src/secrets/acquire.ts queues generic_keeper_task with an objective and
    // no observation; that path must survive the capability landing.
    const env = admit(root, { url: 'https://example.com/', objective: 'Read the heading.' });
    assert.equal(env.GENERIC_OBSERVATION, undefined);
    assert.equal(env.GENERIC_TASK_URL, 'https://example.com/');
    assert.equal(env.GENERIC_TASK_OBJECTIVE, 'Read the heading.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the checked-in declaration is the one this build runs', () => {
  const declared = loadDeclaredObservations(REPO);
  const allowlist = readFileSync(join(REPO, 'src/worker/deploy/weles-action-allowlist.txt'), 'utf8')
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const [name, observation] of declared) {
    assert.equal(name, `${observation.platform}.${observation.verb}`);
    // The point of the capability: a declared observation is not an action.
    assert.equal(
      allowlist.includes(`${observation.platform}_${observation.verb}`),
      false,
      `${name} is still an admitted action, so the verb it replaced was not removed`,
    );
    assert.equal(resolveTrajectory(`${observation.platform}_${observation.verb}`), null);
  }
  // And the four rows no origin could have made observe what they named are
  // gone from both planes rather than left declared.
  for (const action of ['discord_search', 'discord_profile_view', 'instagram_notifications', 'youtube_dwell']) {
    assert.equal(allowlist.includes(action), false, `${action} is still admitted`);
    assert.equal(resolveTrajectory(action), null);
    const [platform, verb] = [action.slice(0, action.indexOf('_')), action.slice(action.indexOf('_') + 1)];
    assert.equal(declared.has(`${platform}.${verb}`), false, `${action} was declared after all`);
  }
});
