/**
 * Writing back what a release published.
 *
 * `released-surface.json` and `release/version-change.json` are the two
 * documents the version gate judges every revision against: the baseline says
 * what the last release exposes, the declaration says which version that was
 * and which one this tree is becoming. Both were kept by hand, and publishing
 * updated neither. So the repository drifted — a baseline stamped 0.5.72 and a
 * manifest at 0.6.7 while the newest published release was 0.5.49 — and the
 * gate then refused every revision, including revisions that changed nothing
 * about the surface. A gate that cannot pass stops being read.
 *
 * `adoptBaseline` takes the surface document the published build carried and
 * the version it was published as, and writes both documents so they say that
 * and only that. The release workflow runs it after it publishes, so the
 * repository follows the release instead of being remembered.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repositoryRoot } from './index.mjs';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;

/** Numeric order, so adopting an older release than the recorded one refuses. */
function ordered(version) {
  const [core] = version.split('-');
  return core.split('.').map((part) => Number(part));
}

function isBehind(candidate, recorded) {
  if (!SEMVER.test(recorded)) return false;
  const [a, b] = [ordered(candidate), ordered(recorded)];
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/**
 * The two documents, as they read after a release of `released` whose build
 * published `publishedSurface`. Pure: the caller decides where they go.
 *
 * `correcting` is for the case this repository was already in: a recorded
 * baseline naming a version that was never published. Moving the baseline
 * backwards is otherwise refused, because a baseline that shrinks lets a
 * surface that was removed pass as newly added. Naming the version being
 * overridden is the difference between correcting a claim and losing one.
 */
export function adoptedDocuments({ publishedSurface, released, reason, recorded, correcting }) {
  if (!SEMVER.test(released ?? '')) {
    throw new Error(`released version ${released ?? '<nothing>'} is not a version`);
  }
  if (!Array.isArray(publishedSurface?.surface) || !publishedSurface.surface.length) {
    throw new Error('the published surface document names no surface');
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new Error('a reason is required: it is what the next reader of the declaration has');
  }
  if (recorded && isBehind(released, recorded) && correcting !== recorded) {
    throw new Error(
      `refusing to record ${released} as published over ${recorded}: `
      + 'a baseline that moves backwards would let a removed surface pass as new. '
      + `Pass --correcting ${recorded} to state that ${recorded} was never published`,
    );
  }
  const surface = [...new Set(publishedSurface.surface)].sort();
  return {
    // The published document carries no version of its own — `surface` reads
    // it from the declaration, which at build time still named the previous
    // release. Stamping it here is what makes the baseline self-describing.
    baseline: { surface, version: released },
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
  correcting,
  root = repositoryRoot(),
  baselinePath = join(root, 'released-surface.json'),
  declarationPath = join(root, 'release/version-change.json'),
}) {
  const publishedSurface = JSON.parse(await readFile(publishedSurfacePath, 'utf8'));
  const recorded = await readFile(baselinePath, 'utf8')
    .then((text) => JSON.parse(text).version)
    .catch((error) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
  const written = adoptedDocuments({ publishedSurface, released, reason, recorded, correcting });
  await writeFile(baselinePath, `${JSON.stringify(written.baseline, null, 2)}\n`);
  await writeFile(declarationPath, `${JSON.stringify(written.declaration, null, 2)}\n`);
  return {
    schema: 'weles.baseline-adoption.v1',
    baseline: baselinePath,
    declaration: declarationPath,
    previous: recorded ?? null,
    corrected: correcting === recorded && correcting !== undefined ? recorded : null,
    released,
    surfaceEntries: written.baseline.surface.length,
  };
}
