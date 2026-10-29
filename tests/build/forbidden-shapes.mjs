#!/usr/bin/env node
// Refuses a committed revision of Weles that brings back a construct a
// repaired defect removed. Each shape below is the source form of one class
// of defect, written as the extended regular expression git grep reads, with
// the reason it may not stand:
//
//   node tests/build/forbidden-shapes.mjs <revision>
//
// Standard output carries one `shape: revision:path:line:text` per instance
// and the run exits nonzero when any instance stands; it is silent and exits
// zero when none does. A revision git cannot read, or a pattern git refuses,
// fails the run with git's reason. This file names the shapes, so it is the
// one file not searched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
// argv holds node and this script before the caller's words.
const [, , revision, ...extra] = process.argv;
assert.ok(
  revision && !extra.length,
  'usage: node tests/build/forbidden-shapes.mjs <revision>',
);

const SEARCHED = [
  'src',
  'tests',
  'scripts',
  'release',
  ':!tests/build/forbidden-shapes.mjs',
];

const SHAPES = [
  {
    name: 'spelled-number',
    pattern: String.raw`Math\.sign\(Infinity\)|FAILED \+ FAILED|(<|>|<=|>=|===|!==|==|!=) *Number\(\)|Number\(\) *(<|>|<=|>=|===|!==|==|!=)`,
    reason:
      'a number spelled so a reader cannot see it is a number with no stated source; name where the value comes from',
  },
  {
    name: 'missing-number-as-zero',
    pattern: String.raw`Number\([^()]*(\?\?|\|\|) *0\)`,
    reason:
      'a missing amount read as zero is a value nobody measured; refuse the missing value by name or read the field the protocol always states',
  },
  {
    name: 'tls-verification-off',
    pattern: String.raw`ignoreHTTPSErrors|rejectUnauthorized: *false|NODE_TLS_REJECT_UNAUTHORIZED`,
    reason:
      'a session that accepts any certificate hands logged-in traffic to whoever sits on the path; trust only the declared proxy keys',
  },
  {
    name: 'stringified-header',
    pattern: String.raw`String\((req|request)\.headers\[`,
    reason:
      'an absent header turned into the text "undefined" reads as a value that was sent; keep it absent (null)',
  },
  {
    name: 'second-secret-store',
    pattern: String.raw`\.weles/secrets\.env`,
    reason: 'secrets come from Skarbiec, not a file beside it',
  },
  {
    name: 'assumed-proxy-port',
    pattern: String.raw`\.port \|\| ['"]80['"]`,
    reason: 'a proxy that states no port is refused, never sent as port 80',
  },
  {
    name: 'unpaced-provider-read',
    pattern: String.raw`readUntilSolved`,
    reason:
      'a provider result read back to back with no pause; providers push their answer, NopeCHA is read at its stated wait (nopechaToken)',
  },
];

let standing = 0;
for (const shape of SHAPES) {
  const found = spawnSync(
    'git',
    [
      '-C',
      root,
      'grep',
      '-n',
      '-E',
      '-e',
      shape.pattern,
      revision,
      '--',
      ...SEARCHED,
    ],
    { encoding: 'utf8', maxBuffer: Infinity },
  );
  // git grep exits nonzero both when nothing matched and when it failed
  // (https://git-scm.com/docs/git-grep#_exit_status); only a failure says why
  // on standard error.
  assert.ok(
    !found.error && found.signal === null && !found.stderr,
    `git grep for ${shape.name} at ${revision} failed (status ${found.status}, signal ${found.signal}${found.error ? `, ${found.error.message}` : ''}): ${found.stderr}`,
  );
  const lines = found.stdout.split('\n').filter((line) => line);
  for (const line of lines) process.stdout.write(`${shape.name}: ${line}\n`);
  if (lines.length) {
    process.stderr.write(
      `${lines.length} instance(s) of ${shape.name} at ${revision}: ${shape.reason}\n`,
    );
    standing += lines.length;
  }
}
assert.equal(
  standing,
  0,
  `${standing} forbidden instance(s) stand at ${revision}; each is listed above with its shape`,
);
