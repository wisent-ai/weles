import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';

import { withoutSecretShapes } from '../capture/secret-shapes/index.cjs';

/** The exit status of a run that succeeded, C's EXIT_SUCCESS: https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/stdlib.h.html */
const EXIT_SUCCESS = 0;

/**
 * Hide credentials git may echo: every credential shape Weles redacts
 * (capture/secret-shapes, which holds the token shapes GitHub issues) and the
 * user part of a URL that carries one.
 */
function redacted(text) {
  return withoutSecretShapes(text).replace(
    /([a-z][a-z+.-]*:\/\/)[^@\s/]+@/gi,
    '$1[redacted]@',
  );
}

/** Publish only the managed figma tree in an existing, explicitly selected checkout. */
export function prepareExport({ checkout, remote, branch }) {
  function git(args) {
    const [verb] = args;
    // git's whole output is read: no size is guessed for it.
    const result = spawnSync('git', ['-C', checkout, ...args], {
      encoding: 'utf8',
      maxBuffer: Number.POSITIVE_INFINITY,
    });
    if (result.error) {
      throw new Error(
        `design export git ${verb} could not run in ${checkout}: ${redacted(result.error.message)}`,
      );
    }
    if (result.status !== EXIT_SUCCESS) {
      const ended =
        result.signal === null
          ? `exited ${result.status}`
          : `was ended by ${result.signal}`;
      throw new Error(
        `design export git ${verb} ${ended} in ${checkout}: ${redacted(result.stderr).trim()}`,
      );
    }
    return result.stdout.trim();
  }
  if (git(['rev-parse', '--show-toplevel']) !== checkout) {
    throw new Error(
      'design export checkout must be the existing repository root',
    );
  }
  git(['check-ref-format', '--branch', branch]);
  if (git(['symbolic-ref', '--short', 'HEAD']) !== branch) {
    throw new Error(
      `design export requires ${checkout} to be on branch ${branch}`,
    );
  }
  const revision = git(['rev-parse', 'HEAD']);
  const [repository, ...others] = git([
    'remote',
    'get-url',
    '--push',
    '--all',
    remote,
  ]).split('\n');
  if (!repository || others.length)
    throw new Error(
      'design export requires exactly one push URL for its Git remote',
    );
  git(['var', 'GIT_AUTHOR_IDENT']);
  git(['var', 'GIT_COMMITTER_IDENT']);
  function clean() {
    if (git(['symbolic-ref', '--short', 'HEAD']) !== branch) {
      throw new Error(
        'design export checkout branch changed during export; generated output was not installed',
      );
    }
    if (git(['status', '--porcelain', '--untracked-files=all'])) {
      throw new Error(
        `design export refuses dirty checkout ${checkout}; existing changes were not replaced`,
      );
    }
    if (
      git([
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--',
        'figma',
      ])
    ) {
      throw new Error(
        'design export refuses ignored files inside the managed figma directory',
      );
    }
    if (git(['rev-parse', 'HEAD']) !== revision) {
      throw new Error(
        'design export checkout revision changed during export; generated output was not installed',
      );
    }
  }
  clean();
  const [remoteRevision] = git([
    'ls-remote',
    '--exit-code',
    repository,
    `refs/heads/${branch}`,
  ]).split(/\s+/);
  if (remoteRevision !== revision) {
    throw new Error(
      `design export refuses divergent ${remote}/${branch}: local ${revision}, remote ${remoteRevision}`,
    );
  }
  const currentRoot = join(checkout, 'figma');
  if (existsSync(currentRoot)) {
    if (!lstatSync(currentRoot).isDirectory())
      throw new Error(
        'design export figma output must be a directory, not a symlink or file',
      );
    const manifest = JSON.parse(
      readFileSync(join(currentRoot, 'inventory.json'), 'utf8'),
    );
    if (
      !Array.isArray(manifest.files) ||
      typeof manifest.generatedAt !== 'string'
    ) {
      throw new Error(
        'design export refuses a figma directory without an export inventory',
      );
    }
  }
  const buildRoot = join(checkout, '.build');
  if (existsSync(buildRoot) && !lstatSync(buildRoot).isDirectory()) {
    throw new Error(
      'design export .build must be a directory, not a symlink or file',
    );
  }
  try {
    git(['check-ignore', '--quiet', '--no-index', '.build/']);
  } catch (error) {
    throw new Error(
      `design export requires an ignored .build/ directory in ${checkout}: ${error.message}`,
    );
  }
  mkdirSync(buildRoot, { recursive: true });
  const lock = join(buildRoot, 'weles-design-export.lock');
  try {
    mkdirSync(lock);
  } catch (error) {
    throw new Error(
      `cannot acquire design export checkout lock ${lock}: ${error.message}`,
    );
  }
  let workspace;
  try {
    workspace = mkdtempSync(join(buildRoot, 'weles-design-export-'));
    const exportRoot = join(workspace, 'figma');
    const cacheRoot = join(workspace, 'documents');
    mkdirSync(exportRoot);
    mkdirSync(cacheRoot);
    return {
      exportRoot,
      cacheRoot,
      publish(generatedAt) {
        clean();
        const previous = join(workspace, 'previous-figma');
        const hadPrevious = existsSync(currentRoot);
        if (hadPrevious) renameSync(currentRoot, previous);
        try {
          renameSync(exportRoot, currentRoot);
        } catch (error) {
          if (hadPrevious) renameSync(previous, currentRoot);
          throw error;
        }
        try {
          git(['add', '--', 'figma']);
          const changes = git([
            'diff',
            '--cached',
            '--name-only',
            '--',
            'figma',
          ]);
          if (changes) {
            // The export's day: the date part of its ISO 8601 timestamp.
            const [day] = generatedAt.split('T');
            git([
              'commit',
              '--only',
              '-m',
              `Export Figma design assets ${day}`,
              '--',
              'figma',
            ]);
            git(['push', repository, `HEAD:refs/heads/${branch}`]);
          }
          const commit = git(['rev-parse', 'HEAD']);
          const [observed] = git([
            'ls-remote',
            '--exit-code',
            repository,
            `refs/heads/${branch}`,
          ]).split(/\s+/);
          if (observed !== commit)
            throw new Error(
              `remote readback differs: local ${commit}, remote ${observed}`,
            );
          return {
            status: changes ? 'published' : 'unchanged',
            checkout,
            remote,
            branch,
            commit,
          };
        } catch (error) {
          throw new Error(
            `${error.message}; generated output and Git state remain in ${checkout}; previous export and working files remain in ${workspace}. Publication was not confirmed.`,
          );
        }
      },
      close(success) {
        try {
          if (success) rmSync(workspace, { recursive: true });
        } finally {
          rmSync(lock, { recursive: true });
        }
      },
    };
  } catch (error) {
    rmSync(lock, { recursive: true });
    throw error;
  }
}
