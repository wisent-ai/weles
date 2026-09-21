// `weles operator-requests` — the capability that asks the person for the one
// action a run cannot perform.
//
// The enrolment trajectory used to wait five minutes for a push approval on
// the operator's phone, print one line into its own log and die with
// `google_push_not_approved`. Nothing told him a run wanted him, for which
// account, or how long he had. So these cases are about being told: a request
// that nobody could page must say so and fail, an unreachable pager must be
// named, and a closed request must say whether the person actually did it and
// how long the run waited for him.
//
// Everything runs the built CLI as a child process against a real request
// directory, because the record and its exit status are the product.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = join(REPO, 'dist', 'cli.js');
const ACCOUNT = 'lukasz.bartoszcze@wisent.ai';
const INSTRUCTION = 'Open the Google app on your phone and tap Yes on the prompt for this account.';

/// A throwaway request directory inside this checkout's ignored `var/`, which
/// is where the workshop allows run state: the OS temp directory is swept on
/// sight on this machine and would take the fixture with it mid-run.
function scratch() {
  const parent = join(REPO, 'var', 'tests-operator-requests');
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, 'dir-'));
}

function weles(args, directory, environment) {
  return spawnSync(process.execPath, [CLI, 'operator-requests', ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      WELES_OPERATOR_REQUEST_DIR: directory,
      WELES_OPERATOR_REQUEST_PAGING: 'off',
      ...environment,
    },
  });
}

function onlyRecord(directory) {
  const files = readdirSync(directory).filter((entry) => entry.endsWith('.json'));
  assert.equal(files.length, 1, `expected one request record in ${directory}, found ${files.length}`);
  return JSON.parse(readFileSync(join(directory, files[0]), 'utf8'));
}

test('an opened request records what the operator has to do, for whom, and by when', () => {
  const directory = scratch();
  const opened = weles(
    ['open', '--kind', 'google-push-approval', '--account', ACCOUNT,
      '--run', 'google-authenticator-enrol codex-wisent-google-sso',
      '--instruction', INSTRUCTION, '--minutes', '5'],
    directory,
  );
  const record = onlyRecord(directory);
  assert.equal(record.account, ACCOUNT);
  assert.equal(record.instruction, INSTRUCTION);
  assert.equal(record.deadline_seconds, 300);
  assert.equal(record.closed_at, null, 'a request nobody answered yet is open');
  assert.ok(
    new Date(record.deadline_at).getTime() > new Date(record.opened_at).getTime(),
    'the deadline is after the moment the request opened',
  );
  assert.match(opened.stdout, /asks for {5}Open the Google app/);
  const listed = weles(['list', '--open'], directory);
  assert.match(listed.stdout, new RegExp(record.id));
  assert.match(listed.stdout, /waiting, \d+s left/);
});

test('a request nobody was paged about fails and says so instead of looking delivered', () => {
  const directory = scratch();
  const opened = weles(
    ['open', '--kind', 'google-push-approval', '--account', ACCOUNT,
      '--run', 'enrol', '--instruction', INSTRUCTION, '--minutes', '5'],
    directory,
  );
  assert.equal(opened.status, 2, `paging off must not report success: ${opened.stdout}${opened.stderr}`);
  assert.match(opened.stdout, /page {9}.*failed: paging disabled by WELES_OPERATOR_REQUEST_PAGING=off/);
  const record = onlyRecord(directory);
  assert.equal(record.pages.length, 1, 'the attempt is recorded even when it delivered nothing');
  assert.equal(record.pages[0].ok, false);
  assert.match(weles(['list'], directory).stdout, /NOT PAGED/);
});

test('a pager that cannot be reached is named, not swallowed', () => {
  const directory = scratch();
  const opened = weles(
    ['open', '--kind', 'google-push-approval', '--account', ACCOUNT,
      '--run', 'enrol', '--instruction', INSTRUCTION, '--minutes', '5'],
    directory,
    { WELES_OPERATOR_REQUEST_PAGING: 'on', WELES_STADO_BIN: join(REPO, 'var', 'no-stado-here') },
  );
  assert.equal(opened.status, 2);
  const record = onlyRecord(directory);
  assert.match(record.pages[0].detail, /Stado pager unavailable/);
});

test('closing a request says whether the person did it and how long the run waited', () => {
  const directory = scratch();
  weles(
    ['open', '--kind', 'google-push-approval', '--account', ACCOUNT,
      '--run', 'enrol', '--instruction', INSTRUCTION, '--minutes', '5'],
    directory,
  );
  const { id } = onlyRecord(directory);

  const undecided = weles(['close', id, '--detail', 'no verdict given'], directory);
  assert.notEqual(undecided.status, 0, 'a close must say whether the operator acted');
  assert.match(undecided.stderr, /--approved or --unapproved/);

  const silent = weles(['close', id, '--approved'], directory);
  assert.notEqual(silent.status, 0, 'a close must carry the sentence explaining the outcome');
  assert.match(silent.stderr, /--detail/);

  const closed = weles(['close', id, '--approved', '--detail', 'the prompt was approved on the phone'], directory);
  assert.equal(closed.status, 0, `${closed.stdout}${closed.stderr}`);
  const record = onlyRecord(directory);
  assert.equal(record.approved, true);
  assert.ok(record.closed_at, 'a closed request carries the moment it closed');
  assert.equal(typeof record.waited_seconds, 'number');
  assert.equal(record.outcome_detail, 'the prompt was approved on the phone');
  assert.match(weles(['show', id], directory).stdout, /operator {5}did it/);
});

test('a waiting request whose deadline has passed reads as unanswered', () => {
  const directory = scratch();
  weles(
    ['open', '--kind', 'google-push-approval', '--account', ACCOUNT,
      '--run', 'enrol', '--instruction', INSTRUCTION, '--minutes', '0.001'],
    directory,
  );
  const listed = weles(['list', '--open'], directory);
  assert.match(listed.stdout, /waiting, deadline passed \d+s ago/);
});
