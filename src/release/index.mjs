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
 *
 * All three used to be separate files under a `scripts/release` folder, which
 * is why the release contract could be run by hand and could not be reached
 * from the product at all.
 */
import ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadManifest } from './manifest.mjs';

const CHANGE_KINDS = ['internal', 'additive', 'breaking'];
const TASK_STATUSES = ['queued', 'leased', 'running', 'succeeded', 'failed', 'cancelled'];

/** The repository root, from this module's own location. */
export function repositoryRoot() {
  return resolve(import.meta.dirname, '..', '..');
}

/**
 * Everything this build publishes, plus the version the repository declares as
 * released. The set is derived from the program the compiler sees, so a surface
 * that changed without a version change cannot pass unnoticed.
 */
export async function surface(root = repositoryRoot()) {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) throw new Error('tsconfig.json not found');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root, { allowJs: true });
  const apiServerPath = join(root, 'src/worker/weles-api-server.mjs');
  const program = ts.createProgram({
    rootNames: [...parsed.fileNames, apiServerPath],
    options: { ...parsed.options, allowJs: true, checkJs: false, noEmit: true },
  });
  const checker = program.getTypeChecker();
  const published = new Set();

  const indexSource = program.getSourceFile(join(root, 'src/index.ts'));
  if (!indexSource) throw new Error('src/index.ts was not parsed');
  const indexSymbol = checker.getSymbolAtLocation(indexSource);
  if (!indexSymbol) throw new Error('src/index.ts has no module symbol');
  for (const symbol of checker.getExportsOfModule(indexSymbol)) {
    published.add(`export:${symbol.getName()}`);
  }

  const packageManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!packageManifest.bin || typeof packageManifest.bin !== 'object') {
    throw new Error('package.json bin map is missing');
  }
  for (const command of Object.keys(packageManifest.bin)) published.add(`cmd:${command}`);

  const cliSource = program.getSourceFile(join(root, 'src/cli.ts'));
  if (!cliSource) throw new Error('src/cli.ts was not parsed');
  let cliCommands = 0;
  for (const node of cliSource.statements) {
    if (!ts.isTypeAliasDeclaration(node) || node.name.text !== 'CliCommand'
      || !ts.isUnionTypeNode(node.type)) continue;
    for (const member of node.type.types) {
      if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) {
        throw new Error('CliCommand contains a non-string member');
      }
      published.add(`cmd:weles ${member.literal.text}`);
      cliCommands += 1;
    }
  }
  if (!cliCommands) throw new Error('no Weles CLI commands resolved');

  const mcpSource = program.getSourceFile(join(root, 'src/mcp.ts'));
  if (!mcpSource) throw new Error('src/mcp.ts was not parsed');
  let mcpTools = 0;
  const collectMcpTools = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.name.text === 'welesMcpTools' && node.initializer
      && ts.isArrayLiteralExpression(node.initializer)) {
      for (const element of node.initializer.elements) {
        if (!ts.isObjectLiteralExpression(element)) {
          throw new Error('welesMcpTools contains a non-object member');
        }
        const name = element.properties.find((property) => ts.isPropertyAssignment(property)
          && property.name?.getText(mcpSource) === 'name');
        if (!name || !ts.isPropertyAssignment(name) || !ts.isStringLiteral(name.initializer)) {
          throw new Error('MCP tool has no static string name');
        }
        published.add(`mcp:${name.initializer.text}`);
        mcpTools += 1;
      }
    }
    ts.forEachChild(node, collectMcpTools);
  };
  collectMcpTools(mcpSource);
  if (!mcpTools) throw new Error('no Weles MCP tools resolved');

  const apiSource = program.getSourceFile(apiServerPath);
  if (!apiSource) throw new Error('worker API server was not parsed');
  let routes = 0;
  const collectRoutes = (node) => {
    if (ts.isStringLiteral(node) && /^(GET|POST|PATCH|DELETE) \/[A-Za-z]/.test(node.text)) {
      published.add(`http:${node.text}`);
      routes += 1;
    }
    ts.forEachChild(node, collectRoutes);
  };
  collectRoutes(apiSource);
  if (!routes) throw new Error('no worker HTTP routes resolved');

  const compatibility = JSON.parse(await readFile(join(root, 'release/compatibility-policy.json'), 'utf8'));
  if (!Array.isArray(compatibility.api?.supportedSchemas) || !compatibility.api.supportedSchemas.length) {
    throw new Error('release compatibility policy has no API schemas');
  }
  for (const schema of compatibility.api.supportedSchemas) published.add(`schema:${schema}`);
  for (const status of TASK_STATUSES) published.add(`task-status:${status}`);

  const versionChange = JSON.parse(await readFile(join(root, 'release/version-change.json'), 'utf8'));
  if (typeof versionChange.current !== 'string' || !versionChange.current) {
    throw new Error('release version-change declaration has no current version');
  }
  return { surface: [...published].sort(), version: versionChange.current };
}

/**
 * The version verdict, or a refusal naming the exact disagreement. Every input
 * is a document some other step produced, and a release passes only when all
 * four of them say the same thing.
 */
export function enforceVersion({ decision, baseline, declaration, manifest }) {
  if (declaration.schema !== 'weles.version-change.v1') {
    throw new Error('unsupported version declaration schema');
  }
  if (typeof declaration.breaking !== 'boolean') {
    throw new Error('version declaration breaking must be boolean');
  }
  if (typeof declaration.reason !== 'string' || !declaration.reason.trim()) {
    throw new Error('version declaration reason is required');
  }
  if (baseline.version !== declaration.current) {
    throw new Error(`baseline version ${baseline.version} does not match declaration current ${declaration.current}`);
  }
  if (decision.current !== declaration.current) {
    throw new Error(`AutoVersion current ${decision.current} does not match declaration current ${declaration.current}`);
  }
  if (manifest.version !== declaration.candidate) {
    throw new Error(`package version ${manifest.version} does not match declaration candidate ${declaration.candidate}`);
  }
  if (!CHANGE_KINDS.includes(decision.change)) {
    throw new Error(`unsupported AutoVersion change ${decision.change}`);
  }
  if (!Array.isArray(decision.added) || !Array.isArray(decision.removed)) {
    throw new Error('AutoVersion decision has no surface difference');
  }
  if (declaration.breaking && decision.change !== 'breaking') {
    throw new Error('declared breaking change was not escalated by AutoVersion');
  }
  if (declaration.candidate === declaration.current) {
    if (decision.change !== 'internal') {
      throw new Error(`surface changed but package remains ${declaration.current}; AutoVersion requires ${decision.next}`);
    }
  } else if (decision.next !== declaration.candidate) {
    throw new Error(`package declares ${declaration.candidate}, but AutoVersion requires ${decision.next}`);
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
 * for and the tag that was cut for it.
 */
export async function validateCandidateManifest({ manifestPath, sourceRevision, candidateTag }) {
  const loaded = await loadManifest(resolve(manifestPath));
  if (loaded.manifest.sourceRevision !== sourceRevision) {
    throw new Error(`manifest sourceRevision ${loaded.manifest.sourceRevision} does not match release target ${sourceRevision}`);
  }
  const expected = `candidate-deployment-${loaded.manifest.deploymentId}-${sourceRevision.slice(0, 8)}`;
  if (expected !== candidateTag) {
    throw new Error(`candidate tag ${candidateTag} does not match manifest ${expected}`);
  }
  return {
    schema: loaded.manifest.schema,
    deploymentId: loaded.manifest.deploymentId,
    sourceRevision: loaded.manifest.sourceRevision,
    sha256: loaded.sha256,
  };
}

/** The documents `enforceVersion` judges, read from disk. */
export async function readVersionInputs({ decision, baseline, declaration, manifest }) {
  const [decisionDoc, baselineDoc, declarationDoc, manifestDoc] = await Promise.all(
    [decision, baseline, declaration, manifest].map(async (path) =>
      JSON.parse(await readFile(resolve(path), 'utf8'))),
  );
  return { decision: decisionDoc, baseline: baselineDoc, declaration: declarationDoc, manifest: manifestDoc };
}
