// `weles errors`: every way a Weles operation can fail, as the operation
// declares it (src/errors). `list` names the operations that declare a
// failure catalogue, `show` prints one operation's causes, and `check` is the
// error-standard gate: it refuses a catalogue that is not one -- a cause
// without its fix or its test, a catch-all code, a test that does not exist --
// and an error message in the source that says a failure happened without
// saying which, the same rules wisent-errors states for every product.
// `check` reads the checkout --root names (the current directory without it),
// so the build under test can check the source it was built from.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import type { ParsedCli } from '../cli.js';
import {
  catalogue,
  genericSentencesIn,
  problems,
  type Operation,
} from '../errors/index.cjs';
import { OPERATIONS } from '../errors/operations/index.cjs';
import { printAnswer, UsageError } from './usage.js';

/** The sources the generic-sentence rule reads, and how each quotes text. */
const SOURCE_EXTENSIONS: Readonly<Record<string, boolean>> = Object.freeze({
  '.ts': true,
  '.mjs': true,
  '.cjs': true,
  '.js': true,
});

function find(id: string): Operation {
  const operation = OPERATIONS.find((entry) => entry.id === id);
  if (!operation)
    throw new UsageError(
      `no operation '${id}' declares a failure catalogue; the operations that do: ${OPERATIONS.map((entry) => entry.id).join(', ')}`,
    );
  return operation;
}

function list(json: boolean): void {
  if (json) {
    printAnswer({ operations: OPERATIONS.map(catalogue) }, true);
    return;
  }
  for (const operation of OPERATIONS)
    process.stdout.write(
      `${operation.id.padEnd(18)} ${String(operation.causes.length).padStart(3)} causes  ${operation.command}\n`,
    );
}

function show(id: string, json: boolean): void {
  const operation = find(id);
  if (json) {
    printAnswer(catalogue(operation), true);
    return;
  }
  const listed = catalogue(operation) as {
    causes: Record<string, unknown>[];
  };
  process.stdout.write(
    `${operation.command}  (${operation.id})\n${operation.summary}\n`,
  );
  for (const cause of listed.causes)
    process.stdout.write(
      `\n${cause.id}  [${cause.code}] exit ${cause.exit}, HTTP ${cause.status}\n  failed:   ${cause.failed}\n  cause:    ${cause.cause}\n  observed: ${cause.observed}\n  fix:      ${cause.remedy}\n  test:     ${cause.test}\n  docs:     ${cause.doc}\n`,
    );
}

/** Every source file under `directory`, recursively. */
function sources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sources(path));
    else if (Object.hasOwn(SOURCE_EXTENSIONS, extname(entry.name)))
      found.push(path);
  }
  return found;
}

/** The test names a test file declares, as `test('name'` or `journey('name'` calls. */
function declaredTests(path: string): Set<string> {
  const text = readFileSync(path, 'utf8');
  const names = new Set<string>();
  for (const match of text.matchAll(/\b(?:test|journey)\(\s*'([a-z0-9_]+)'/g))
    names.add(match[1]);
  return names;
}

/**
 * Everything that keeps the tree from the error standard: a declaration that
 * is not a complete cause, a cause whose test file or test does not exist in
 * this checkout, and a generic sentence in the source.
 */
function check(root: string, json: boolean): void {
  for (const directory of ['src', 'tests'])
    if (!existsSync(join(root, directory)))
      throw new UsageError(
        `errors check reads a Weles checkout, and ${root} holds no ${directory} directory; run it in the checkout or name it with --root`,
      );
  const found: string[] = [];
  const testFiles = new Map<string, Set<string> | null>();
  for (const operation of OPERATIONS) {
    found.push(...problems(operation));
    for (const cause of operation.causes) {
      const [file, name] = cause.test.split('::');
      if (!testFiles.has(file)) {
        let names: Set<string> | null = null;
        try {
          names = declaredTests(join(root, file));
        } catch {
          names = null;
        }
        testFiles.set(file, names);
      }
      const names = testFiles.get(file);
      if (!names)
        found.push(
          `${operation.id}: cause ${cause.id}: its test file ${file} does not exist in ${root}`,
        );
      else if (!names.has(name))
        found.push(
          `${operation.id}: cause ${cause.id}: ${file} declares no test ${name}`,
        );
    }
  }
  let generic = 0;
  for (const path of sources(join(root, 'src'))) {
    const singleQuoted = SOURCE_EXTENSIONS[extname(path)];
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        for (const sentence of genericSentencesIn(line, singleQuoted)) {
          generic += 1;
          found.push(
            `${relative(root, path)}:${index + 1}: "${sentence.text}" ${sentence.reason}; say what failed, the state observed and what fixes it`,
          );
        }
      });
  }
  const causes = OPERATIONS.reduce(
    (total, operation) => total + operation.causes.length,
    0,
  );
  const answer = {
    operations: OPERATIONS.length,
    causes,
    generic_sentences: generic,
    problems: found,
  };
  if (json) printAnswer(answer, true);
  else {
    for (const problem of found) process.stdout.write(`${problem}\n`);
    process.stdout.write(
      `${OPERATIONS.length} operation(s) declare ${causes} cause(s); ${generic} generic sentence(s) in the source; ${found.length} problem(s)\n`,
    );
  }
  if (found.length)
    throw new Error(
      `the error standard is not met: ${found.length} problem(s), listed above`,
    );
}

export async function runErrors(parsed: ParsedCli): Promise<void> {
  const [action, id, ...rest] = parsed.positional;
  const json = parsed.options.json === true;
  const taken = action === 'check' ? ['json', 'root'] : ['json'];
  const extra = Object.keys(parsed.options).filter(
    (key) => !taken.includes(key),
  );
  if (extra.length)
    throw new UsageError(
      `errors ${action ?? ''} takes only ${taken.map((key) => `--${key}`).join(' ')}; got ${extra.map((key) => `--${key}`).join(' ')}`,
    );
  if (action === 'list' && id === undefined) return list(json);
  if (action === 'show' && id !== undefined && !rest.length)
    return show(id, json);
  if (action === 'check' && id === undefined) {
    const named = parsed.options.root;
    if (named !== undefined && (typeof named !== 'string' || !named))
      throw new UsageError('errors check --root needs the checkout directory');
    return check(resolve(typeof named === 'string' ? named : '.'), json);
  }
  throw new UsageError(
    'errors takes: list [--json], show <operation> [--json], or check [--root <checkout>] [--json]',
  );
}
