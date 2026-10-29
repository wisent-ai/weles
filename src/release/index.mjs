/**
 * The three release judgements `weles release` answers.
 *
 * `surface` reads what this build publishes — library exports, CLI commands,
 * MCP tools, worker HTTP routes, API schemas, task statuses — from the source
 * itself through the TypeScript program, never from a hand-kept list.
 * `enforceVersion` compares AutoVersion's decision, the released baseline, the
 * repository's own version declaration and the package manifest, and refuses
 * every disagreement between them. `validateCandidateManifest` judges a
 * candidate deployment manifest against the revision and tag the release is
 * for.
 */
import ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadManifest } from './manifest.mjs';
import {
  cliCommands,
  httpRoutes,
  mcpTools,
  serverModules,
} from './surface/published.mjs';
import {
  NONTERMINAL_STATUSES,
  TERMINAL_STATUSES,
} from '../worker/public-task-service/wire.mjs';

// AutoVersion's change decisions, each with what it says about the surface.
const CHANGE_KINDS = {
  internal: 'no published surface changed',
  additive: 'surface was added and none removed',
  breaking: 'published surface was removed',
};

/** A candidate tag: this prefix, the deployment id, then the revision's abbreviation. */
const CANDIDATE_TAG_PREFIX = 'candidate-deployment-';

/** The repository root, from this module's own location. */
export function repositoryRoot() {
  return resolve(import.meta.dirname, '..', '..');
}

/** The TypeScript program of the build, with the worker API server's modules. */
function buildProgram(root, apiServerPaths) {
  const configPath = ts.findConfigFile(
    root,
    ts.sys.fileExists,
    'tsconfig.json',
  );
  if (!configPath) throw new Error('tsconfig.json not found');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error)
    throw new Error(
      ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'),
    );
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    root,
    { allowJs: true },
  );
  return ts.createProgram({
    rootNames: [...parsed.fileNames, ...apiServerPaths],
    options: { ...parsed.options, allowJs: true, checkJs: false, noEmit: true },
  });
}

/** Each name `src/index.ts` exports. */
function libraryExports(program, root) {
  const indexSource = program.getSourceFile(join(root, 'src/index.ts'));
  if (!indexSource) throw new Error('src/index.ts was not parsed');
  const checker = program.getTypeChecker();
  const indexSymbol = checker.getSymbolAtLocation(indexSource);
  if (!indexSymbol) throw new Error('src/index.ts has no module symbol');
  return checker
    .getExportsOfModule(indexSymbol)
    .map((symbol) => `export:${symbol.getName()}`);
}

async function jsonAt(root, path) {
  return JSON.parse(await readFile(join(root, path), 'utf8'));
}

/**
 * Everything this build publishes, plus the version the repository declares as
 * released. The set is derived from the program the compiler sees, so a surface
 * that changed without a version change cannot pass unnoticed.
 */
export async function surface(root = repositoryRoot()) {
  const apiServerPaths = await serverModules(
    root,
    'src/worker/weles-api-server.mjs',
    'src/worker/weles-api-server',
    '.mjs',
  );
  const program = buildProgram(root, apiServerPaths);
  const published = new Set(libraryExports(program, root));

  const packageManifest = await jsonAt(root, 'package.json');
  if (!packageManifest.bin || typeof packageManifest.bin !== 'object')
    throw new Error('package.json bin map is missing');
  for (const command of Object.keys(packageManifest.bin))
    published.add(`cmd:${command}`);
  for (const command of cliCommands(program, root)) published.add(command);

  const mcpPaths = await serverModules(root, 'src/mcp.ts', 'src/mcp', '.ts');
  for (const tool of mcpTools(program, mcpPaths)) published.add(tool);
  for (const route of httpRoutes(program, apiServerPaths)) published.add(route);

  const compatibility = await jsonAt(root, 'release/compatibility-policy.json');
  if (
    !Array.isArray(compatibility.api?.supportedSchemas) ||
    !compatibility.api.supportedSchemas.length
  )
    throw new Error('release compatibility policy has no API schemas');
  for (const schema of compatibility.api.supportedSchemas)
    published.add(`schema:${schema}`);
  // The task statuses are the public task service's wire vocabulary, read
  // from the module that refuses any other status at its boundary.
  for (const status of Object.keys({
    ...NONTERMINAL_STATUSES,
    ...TERMINAL_STATUSES,
  }))
    published.add(`task-status:${status}`);

  const versionChange = await jsonAt(root, 'release/version-change.json');
  if (typeof versionChange.current !== 'string' || !versionChange.current)
    throw new Error(
      'release version-change declaration has no current version',
    );
  return { surface: [...published].sort(), version: versionChange.current };
}

/**
 * The version verdict, or a refusal naming the exact disagreement. Every input
 * is a document some other step produced, and a release passes only when all
 * four of them say the same thing.
 */
export function enforceVersion({ decision, baseline, declaration, manifest }) {
  if (declaration.schema !== 'weles.version-change.v1')
    throw new Error('unsupported version declaration schema');
  if (typeof declaration.breaking !== 'boolean')
    throw new Error('version declaration breaking must be boolean');
  if (typeof declaration.reason !== 'string' || !declaration.reason.trim())
    throw new Error('version declaration reason is required');
  if (baseline.version !== declaration.current)
    throw new Error(
      `baseline version ${baseline.version} does not match declaration current ${declaration.current}`,
    );
  if (decision.current !== declaration.current)
    throw new Error(
      `AutoVersion current ${decision.current} does not match declaration current ${declaration.current}`,
    );
  if (manifest.version !== declaration.candidate)
    throw new Error(
      `package version ${manifest.version} does not match declaration candidate ${declaration.candidate}`,
    );
  if (!Object.hasOwn(CHANGE_KINDS, decision.change))
    throw new Error(`unsupported AutoVersion change ${decision.change}`);
  if (!Array.isArray(decision.added) || !Array.isArray(decision.removed))
    throw new Error('AutoVersion decision has no surface difference');
  if (declaration.breaking && decision.change !== 'breaking')
    throw new Error(
      'declared breaking change was not escalated by AutoVersion',
    );
  if (declaration.candidate === declaration.current) {
    if (decision.change !== 'internal')
      throw new Error(
        `surface changed but package remains ${declaration.current}; AutoVersion requires ${decision.next}`,
      );
  } else if (decision.next !== declaration.candidate) {
    throw new Error(
      `package declares ${declaration.candidate}, but AutoVersion requires ${decision.next}`,
    );
  }
  return {
    schema: 'weles.version-verdict.v1',
    released: declaration.current,
    declared: declaration.candidate,
    change: decision.change,
    required: decision.next,
    breakingDeclared: declaration.breaking,
    added: decision.added,
    removed: decision.removed,
  };
}

/**
 * A candidate deployment manifest, judged against the revision the release is
 * for and the tag that was cut for it: the tag names the manifest's deployment
 * and an abbreviation of that revision.
 */
export async function validateCandidateManifest({
  manifestPath,
  sourceRevision,
  candidateTag,
}) {
  const loaded = await loadManifest(resolve(manifestPath));
  if (loaded.manifest.sourceRevision !== sourceRevision)
    throw new Error(
      `manifest sourceRevision ${loaded.manifest.sourceRevision} does not match release target ${sourceRevision}`,
    );
  const prefix = `${CANDIDATE_TAG_PREFIX}${loaded.manifest.deploymentId}-`;
  const abbreviation = candidateTag.slice(prefix.length);
  if (
    !candidateTag.startsWith(prefix) ||
    !abbreviation ||
    !sourceRevision.startsWith(abbreviation)
  )
    throw new Error(
      `candidate tag ${candidateTag} does not match manifest: expected ${prefix}<abbreviation of ${sourceRevision}>`,
    );
  return {
    schema: loaded.manifest.schema,
    deploymentId: loaded.manifest.deploymentId,
    sourceRevision: loaded.manifest.sourceRevision,
    sha256: loaded.sha256,
  };
}

/** The documents `enforceVersion` judges, read from disk. */
export async function readVersionInputs({
  decision,
  baseline,
  declaration,
  manifest,
}) {
  const [decisionDoc, baselineDoc, declarationDoc, manifestDoc] =
    await Promise.all(
      [decision, baseline, declaration, manifest].map(async (path) =>
        JSON.parse(await readFile(resolve(path), 'utf8')),
      ),
    );
  return {
    decision: decisionDoc,
    baseline: baselineDoc,
    declaration: declarationDoc,
    manifest: manifestDoc,
  };
}
