/**
 * Writing back what a release published.
 *
 * `released-surface.json` and `release/version-change.json` are the two
 * documents the version gate judges every revision against: the baseline says
 * what the last release exposes, the declaration says which version that was
 * and which one this tree is becoming. Kept by hand, they drift from what was
 * published, and a gate judging against a drifted baseline refuses revisions
 * that changed nothing about the surface.
 *
 * `adoptBaseline` takes the surface document the published build carried and
 * the version it was published as, and writes both documents so they say that
 * and only that. The release workflow runs it after it publishes, so the
 * repository follows the release instead of being remembered.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repositoryRoot } from './index.mjs';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/; // https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
const INDENT = '  ';

/** A version's major, minor and patch, in that order. */
function ordered(version) {
  const [core] = version.split('-');
  return core.split('.').map((part) => Number(part));
}

/**
 * Whether `candidate` precedes `recorded`. A recorded baseline that is not a
 * version is refused: nothing could say whether a release moves back from it.
 */
function isBehind(candidate, recorded) {
  if (!SEMVER.test(recorded))
    throw new Error(
      `the recorded baseline version ${recorded} is not a version`,
    );
  const theirs = ordered(recorded);
  for (const [index, mine] of ordered(candidate).entries()) {
    if (mine !== theirs[index]) return mine < theirs[index];
  }
  return false;
}

/**
 * The two documents, as they read after a release of `released` whose build
 * published `publishedSurface`. Pure: the caller decides where they go.
 *
 * `correcting` is for a recorded baseline naming a version that was never
 * published. Moving the baseline backwards is otherwise refused, because a
 * baseline that shrinks lets a surface that was removed pass as newly added.
 * Naming the version being overridden is the difference between correcting a
 * claim and losing one.
 *
 * `source` names the published artifact the surface was read from, its first
 * word a marker (`stado://releases/<product>/<version>/<platform>`). Stado's
 * release submit refuses a baseline that names none, because nothing could
 * then verify which release the baseline describes.
 */
export function adoptedDocuments({
  publishedSurface,
  released,
  reason,
  source,
  recorded,
  correcting,
}) {
  if (typeof released !== 'string')
    throw new Error('the released version is required');
  if (!SEMVER.test(released)) {
    throw new Error(`released version ${released} is not a version`);
  }
  if (
    !Array.isArray(publishedSurface?.surface) ||
    !publishedSurface.surface.length
  ) {
    throw new Error('the published surface document names no surface');
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new Error(
      'a reason is required: it is what the next reader of the declaration has',
    );
  }
  if (typeof source !== 'string' || !source.trim()) {
    throw new Error(
      'a source is required: the published artifact the surface was read from, which Stado verifies the baseline against',
    );
  }
  if (
    recorded !== null &&
    isBehind(released, recorded) &&
    correcting !== recorded
  ) {
    throw new Error(
      `refusing to record ${released} as published over ${recorded}: ` +
        'a baseline that moves backwards would let a removed surface pass as new. ' +
        `Pass --correcting ${recorded} to state that ${recorded} was never published`,
    );
  }
  const surface = [...new Set(publishedSurface.surface)].sort();
  return {
    // The published document carries no version of its own — `surface` reads
    // it from the declaration, which at build time still named the previous
    // release. Stamping it here is what makes the baseline self-describing.
    baseline: { surface, version: released, source: source.trim() },
    declaration: {
      schema: 'weles.version-change.v1',
      current: released,
      candidate: released,
      breaking: false,
      reason: reason.trim(),
    },
  };
}

/**
 * Write both documents. Returns what was written, so a caller that commits the
 * result can say which versions it moved between.
 */
export async function adoptBaseline({
  publishedSurfacePath,
  released,
  reason,
  source,
  correcting,
  root = repositoryRoot(),
  baselinePath = join(root, 'released-surface.json'),
  declarationPath = join(root, 'release/version-change.json'),
}) {
  const publishedSurface = JSON.parse(
    await readFile(publishedSurfacePath, 'utf8'),
  );
  // No baseline file is no recorded baseline; one that exists must state the
  // version it records, or nothing can say whether this release moves back.
  const recorded = await readFile(baselinePath, 'utf8').then(
    (text) => {
      const version = JSON.parse(text).version;
      if (typeof version !== 'string')
        throw new Error(`${baselinePath} records no version`);
      return version;
    },
    (error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    },
  );
  const written = adoptedDocuments({
    publishedSurface,
    released,
    reason,
    source,
    recorded,
    correcting,
  });
  await writeFile(
    baselinePath,
    `${JSON.stringify(written.baseline, null, INDENT)}\n`,
  );
  await writeFile(
    declarationPath,
    `${JSON.stringify(written.declaration, null, INDENT)}\n`,
  );
  return {
    schema: 'weles.baseline-adoption.v1',
    baseline: baselinePath,
    declaration: declarationPath,
    previous: recorded,
    corrected:
      correcting !== undefined && correcting === recorded ? recorded : null,
    released,
    surfaceEntries: written.baseline.surface.length,
  };
}
