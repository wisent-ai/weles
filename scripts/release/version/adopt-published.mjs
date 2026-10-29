#!/usr/bin/env node
// Record what Stado publishes of this product as the version gate's baseline.
//
// `released-surface.json` and `release/version-change.json` are what the
// version gate judges a revision against. This reads the release Stado serves
// (`stado release status <product> --json`), fetches its signed archive for
// the exact source revision it was built from (`stado release fetch`), takes
// the surface document the build carried out of the runtime payload, and
// writes both documents through adoptBaseline. It is run by hand before
// `npm version`, as https://weles.wisent.com/docs/versions lists, so each bump starts from what is
// published; no npm lifecycle script runs it, since only the caller knows the
// platform whose archive to read.
//
// Usage: node scripts/release/version/adopt-published.mjs --platform <platform> [--root <directory>]
//   --platform  the release platform whose archive is read, as the manifest names it
//   --root      the checkout whose documents are written (default: this one)

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { adoptBaseline } from '../../../src/release/baseline.mjs';
import { repositoryRoot } from '../../../src/release/index.mjs';

const { values } = parseArgs({
  options: { platform: { type: 'string' }, root: { type: 'string' } },
});
if (!values.platform) {
  throw new Error(
    '--platform is required: name the release platform whose published archive is read',
  );
}
const platform = values.platform;
const root = values.root ? resolve(values.root) : repositoryRoot();
const manifest = JSON.parse(
  readFileSync(join(root, '.wisent-release.json'), 'utf8'),
);
const product = manifest.product;
const payload = manifest.runtime?.binary;
if (typeof product !== 'string' || typeof payload !== 'string') {
  throw new Error(
    '.wisent-release.json names no product or runtime.binary to read the published surface from',
  );
}

/** A finished command; refuses when it could not start. */
function spawn(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: Number.POSITIVE_INFINITY,
  });
  if (result.error)
    throw new Error(
      `${command} ${args.join(' ')} could not run: ${result.error.message}`,
    );
  return result;
}

/** One command that must succeed; its standard output. */
function run(command, args) {
  const result = spawn(command, args);
  // Any status but success is a refusal: https://www.gnu.org/software/bash/manual/html_node/Exit-Status.html
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${result.status}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

// Every target Stado rolls this product out to names the release it desires;
// a rollout still moving between two releases has no single published one.
// `stado release status` also exits nonzero when a target cannot be shown to
// run what it desires; that is a finding about the rollout, not about what
// was published, so its document is still read and its finding is repeated.
const statusArgs = ['release', 'status', product, '--json'];
const answered = spawn('stado', statusArgs);
if (!answered.stdout.trim()) {
  throw new Error(
    `stado ${statusArgs.join(' ')} exited ${answered.status} with no document: ${answered.stderr.trim()}`,
  );
}
const status = JSON.parse(answered.stdout);
if (!Array.isArray(status.targets)) {
  throw new Error(`stado ${statusArgs.join(' ')} answered no targets list`);
}
// https://www.gnu.org/software/bash/manual/html_node/Exit-Status.html
if (answered.status !== 0) {
  const finding = answered.stderr.trim().split('\n').at(-1);
  console.error(
    `stado ${statusArgs.join(' ')} exited ${answered.status}: ${finding}`,
  );
}
const published = new Map();
for (const target of status.targets) {
  const artifact = target.desired?.artifacts?.[platform];
  if (artifact) {
    published.set(`${target.desired.version}@${artifact.source_revision}`, {
      version: target.desired.version,
      source: artifact.source_revision,
      target: target.target,
    });
  }
}
const [release, ...others] = published.values();
if (!release) {
  throw new Error(
    `stado release status ${product} names no desired ${platform} release on any target`,
  );
}
if (others.length) {
  const named = [release, ...others].map(
    (each) => `${each.target}: ${each.version} from ${each.source}`,
  );
  throw new Error(
    `the targets of ${product} desire different releases (${named.join('; ')}); adopt once the rollout settles`,
  );
}
const { version, source } = release;

const directory = join(
  root,
  '.build',
  'published',
  `${product}-${version}-${platform}`,
);
mkdirSync(directory, { recursive: true });
const archive = join(directory, 'release.tar.gz');
run('stado', [
  'release',
  'fetch',
  product,
  version,
  '--platform',
  platform,
  '--source-commit',
  source,
  '--destination',
  archive,
  '--json',
]);
run('tar', ['-xzf', archive, '-C', directory, payload]);
run('tar', [
  '-xzf',
  join(directory, payload),
  '-C',
  directory,
  'released-surface.json',
]);

const written = await adoptBaseline({
  publishedSurfacePath: join(directory, 'released-surface.json'),
  released: version,
  reason: `${product} ${version} is the release Stado serves; its ${platform} archive, built from ${source}, published this surface.`,
  root,
  baselinePath: join(root, 'released-surface.json'),
  declarationPath: join(root, 'release', 'version-change.json'),
});
console.log(JSON.stringify(written));
