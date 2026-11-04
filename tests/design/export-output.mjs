// `weles design export` publishes into the directory its request names:
// `figma` when the request names none, `libraries/<name>/figma` for a
// repository that keeps several design libraries. Real git: a checkout and
// its bare remote under this repository's ignored .build/, a real commit and
// push of the published tree, and the remote read back.
//
//   node tests/design/export-output.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { readExportRequest } from '../../src/figma/export-request.mjs';
import { prepareExport } from '../../src/figma/export-checkout.mjs';

const root = resolve(import.meta.dirname, '../..');
const work = join(root, '.build', 'design-export-output', randomUUID());
const remote = join(work, 'remote.git');
const checkout = join(work, 'checkout');
const inputs = join(work, 'inputs');

function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function request(fields) {
  const path = join(inputs, `request-${randomUUID()}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      inventory: 'inventory.json',
      checkout: '../checkout',
      remote: 'origin',
      branch: 'main',
      credential: {
        endpoint: 'https://skarbiec.example.org',
        consumer: 'weles-figma-design-assets-exporter',
        item: 'figma',
        field: 'api_key',
        scopeFile: 'scopes.conf',
        workloadId: 'design-export',
        signingKeyFile: 'signing.key',
      },
      ...fields,
    }),
  );
  return path;
}

function refuses(fields, pattern) {
  assert.throws(() => readExportRequest(request(fields)), pattern);
}

mkdirSync(inputs, { recursive: true });
try {
  spawnSync('git', ['init', '--bare', '--initial-branch=main', remote]);
  spawnSync('git', ['init', '--initial-branch=main', checkout]);
  git(checkout, 'config', 'user.name', 'Weles design export test');
  git(checkout, 'config', 'user.email', 'design-export-test@wisent.invalid');
  git(checkout, 'remote', 'add', 'origin', remote);
  writeFileSync(join(checkout, '.gitignore'), '.build/\n');
  git(checkout, 'add', '.gitignore');
  git(checkout, 'commit', '-m', 'start');
  git(checkout, 'push', 'origin', 'HEAD:refs/heads/main');
  writeFileSync(
    join(inputs, 'inventory.json'),
    JSON.stringify({
      teamId: '1',
      companyFiles: [
        { name: 'Library', url: 'https://www.figma.com/design/AbC123/Library' },
      ],
    }),
  );
  writeFileSync(join(inputs, 'scopes.conf'), 'scope\n');
  writeFileSync(join(inputs, 'signing.key'), 'key\n');

  // The default is the directory every existing request publishes to.
  assert.equal(readExportRequest(request({})).output, 'figma');
  const named = readExportRequest(
    request({ output: 'libraries/forest/figma/' }),
  );
  assert.equal(named.output, 'libraries/forest/figma');

  // Refusals: outside the checkout, the checkout itself, git's own store,
  // an empty name, and an input file inside the managed directory.
  refuses({ output: '/etc' }, /must be a directory inside the checkout/);
  refuses({ output: '../elsewhere' }, /must be a directory inside the checkout/);
  refuses({ output: '.' }, /must be a directory inside the checkout/);
  refuses({ output: '.git/hooks' }, /must be a directory inside the checkout/);
  refuses({ output: '' }, /requires a non-empty output/);
  mkdirSync(join(checkout, 'libraries/forest/figma'), { recursive: true });
  writeFileSync(join(checkout, 'libraries/forest/figma/scopes.conf'), 'x\n');
  refuses(
    {
      output: 'libraries/forest/figma',
      credential: {
        endpoint: 'https://skarbiec.example.org',
        consumer: 'c',
        item: 'i',
        field: 'f',
        scopeFile: '../checkout/libraries/forest/figma/scopes.conf',
        workloadId: 'w',
        signingKeyFile: 'signing.key',
      },
    },
    /must be outside the managed output directory libraries\/forest\/figma/,
  );
  rmSync(join(checkout, 'libraries'), { recursive: true });

  // Publication into a library directory that does not exist yet: only that
  // tree is committed and pushed, and the remote holds the commit.
  const workspace = prepareExport(named);
  writeFileSync(
    join(workspace.exportRoot, 'inventory.json'),
    `${JSON.stringify({ generatedAt: '2026-11-04T00:00:00.000Z', files: [] })}\n`,
  );
  const published = workspace.publish('2026-11-04T00:00:00.000Z');
  workspace.close(true);
  assert.equal(published.status, 'published');
  assert.equal(
    git(remote, 'rev-parse', 'refs/heads/main'),
    published.commit,
  );
  assert.equal(
    git(checkout, 'show', '--name-only', '--format=', 'HEAD'),
    'libraries/forest/figma/inventory.json',
  );
  assert.ok(!existsSync(join(checkout, 'figma')));
  assert.equal(
    JSON.parse(
      readFileSync(
        join(checkout, 'libraries/forest/figma/inventory.json'),
        'utf8',
      ),
    ).generatedAt,
    '2026-11-04T00:00:00.000Z',
  );

  // A second export replaces the tree it published, and a directory that
  // is not an export is refused instead of being replaced.
  const again = prepareExport(named);
  writeFileSync(
    join(again.exportRoot, 'inventory.json'),
    `${JSON.stringify({ generatedAt: '2026-11-05T00:00:00.000Z', files: [] })}\n`,
  );
  assert.equal(again.publish('2026-11-05T00:00:00.000Z').status, 'published');
  again.close(true);
  mkdirSync(join(checkout, 'notes'));
  writeFileSync(join(checkout, 'notes/inventory.json'), '{}\n');
  git(checkout, 'add', 'notes');
  git(checkout, 'commit', '-m', 'notes');
  git(checkout, 'push', 'origin', 'HEAD:refs/heads/main');
  assert.throws(
    () => prepareExport({ ...named, output: 'notes' }),
    /design export refuses notes, a directory without an export inventory/,
  );
  console.log(
    'design export output: default figma, named library directory published and pushed, six refusals',
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
