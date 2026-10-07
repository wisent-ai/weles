import { readFileSync } from 'node:fs';
import {
  importWelesTrajectoryFile,
  type WelesImportReport,
} from '../runtime/import.js';
import {
  runWelesOnboarding,
  type WelesOnboardingInput,
} from '../onboarding/first-use.js';
import type { ParsedCli } from '../cli.js';
import { printAnswer, UsageError } from './usage.js';
function readJsonFile(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read ${label}: ${message}`);
  }
}

function readReceiptKeys(path: string): Readonly<Record<string, string>> {
  const value = readJsonFile(path, 'receipt key map');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('receipt key map must be a JSON object');
  }
  const entries = Object.entries(value);
  if (entries.length === 0)
    throw new Error('receipt key map must not be empty');
  const keys: Record<string, string> = {};
  for (const [key, publicKey] of entries) {
    if (!key || typeof publicKey !== 'string' || !publicKey.trim()) {
      throw new Error(
        'receipt key map must contain non-empty key IDs and PEM public keys',
      );
    }
    keys[key] = publicKey;
  }
  return keys;
}

async function executeImport(parsed: ParsedCli): Promise<WelesImportReport> {
  const [path] = parsed.positional;
  if (!path || parsed.positional.length !== 1)
    throw new UsageError('import requires <trajectory-export.json>');
  if (typeof parsed.options.host !== 'string')
    throw new UsageError('import requires --host <managed-worker-hostname>');
  const report = await importWelesTrajectoryFile(path, parsed.options.host);
  // A refused row is a refusal of a well-formed import, so it exits 1; 2 is
  // every Weles usage error.
  if (report.refused > 0) process.exitCode = 1;
  return report;
}

export async function runImport(parsed: ParsedCli): Promise<void> {
  const report = await executeImport(parsed);
  printAnswer(report, parsed.options.json === true);
}

function isOnboardingAction(
  value: string,
): value is NonNullable<WelesOnboardingInput['action']> {
  return (
    value === 'status' ||
    value === 'next' ||
    value === 'verify' ||
    value === 'reset'
  );
}

export async function runOnboarding(parsed: ParsedCli): Promise<void> {
  const action = parsed.positional[0] ?? 'status';
  if (action === 'import') {
    if (parsed.positional.length !== 2) {
      throw new UsageError(
        'onboarding import requires <trajectory-export.json>',
      );
    }
    const common = {
      subject:
        typeof parsed.options.subject === 'string'
          ? parsed.options.subject
          : undefined,
      stateDirectory:
        typeof parsed.options['state-dir'] === 'string'
          ? parsed.options['state-dir']
          : undefined,
    };
    const before = await runWelesOnboarding({ action: 'status', ...common });
    if (before.screen.id !== 'existing-data') {
      throw new Error(
        'complete the authorization-boundary step before importing existing data',
      );
    }
    const report = await executeImport({
      ...parsed,
      command: 'import',
      positional: parsed.positional.slice(1),
    });
    if (report.imported + report.unchanged === 0) {
      printAnswer(
        { import: report, onboarding: before },
        parsed.options.json === true,
      );
      return;
    }
    const view = await runWelesOnboarding({
      action: 'import',
      importReport: report,
      ...common,
    });
    printAnswer(
      { import: report, onboarding: view },
      parsed.options.json === true,
    );
    return;
  }
  if (!isOnboardingAction(action) || parsed.positional.length > 1) {
    throw new Error(
      'onboarding action must be status, next, import, verify, or reset',
    );
  }
  const receiptPath = parsed.options.receipt;
  const keysPath = parsed.options.keys;
  if (
    action === 'verify' &&
    (typeof receiptPath !== 'string' || typeof keysPath !== 'string')
  ) {
    throw new UsageError(
      'onboarding verify requires --receipt <file> and --keys <file>',
    );
  }
  const receiptDocument =
    typeof receiptPath === 'string'
      ? readJsonFile(receiptPath, 'workflow receipt')
      : undefined;
  const receipt =
    receiptDocument &&
    typeof receiptDocument === 'object' &&
    'receipt' in receiptDocument
      ? receiptDocument.receipt
      : receiptDocument;
  const view = await runWelesOnboarding({
    action,
    subject:
      typeof parsed.options.subject === 'string'
        ? parsed.options.subject
        : undefined,
    stateDirectory:
      typeof parsed.options['state-dir'] === 'string'
        ? parsed.options['state-dir']
        : undefined,
    receipt,
    receiptKeys:
      typeof keysPath === 'string' ? readReceiptKeys(keysPath) : undefined,
  });
  printAnswer(view, parsed.options.json === true);
}

/**
 * `weles release <surface|enforce-version|validate-manifest|adopt-baseline>` —
 * the judgements the release pipeline asks this product to make about itself,
 * and the write-back that keeps the documents those judgements read truthful.
 */
export async function runRelease(parsed: ParsedCli): Promise<void> {
  // The release judgements are ES modules and this CLI compiles to CommonJS,
  // which cannot static-import ESM: `await import()` is the only load that
  // works, not a preference.
  const release = await import('../release/index.mjs');
  const [action] = parsed.positional;
  const option = (name: string): string => {
    const value = parsed.options[name];
    if (typeof value !== 'string' || !value.trim())
      throw new Error(`--${name} is required`);
    return value;
  };
  if (action === 'surface') {
    // `--root` reads the surface of another tree, which is how the surface a
    // published release exposes is recovered: extract that release's source
    // revision and read it with today's reader, rather than trusting a
    // document the build wrote when the reader was broken.
    const root =
      typeof parsed.options.root === 'string' && parsed.options.root.trim()
        ? parsed.options.root
        : undefined;
    process.stdout.write(
      `${JSON.stringify(await release.surface(root), null, 2)}\n`,
    );
    return;
  }
  if (action === 'enforce-version') {
    const inputs = await release.readVersionInputs({
      decision: option('decision'),
      baseline: option('baseline'),
      declaration: option('declaration'),
      manifest: option('manifest'),
    });
    printAnswer(release.enforceVersion(inputs), parsed.options.json === true);
    return;
  }
  if (action === 'adopt-baseline') {
    // ES module, same reason as the load above: this file compiles to
    // CommonJS, which cannot static-import it.
    const baseline = await import('../release/baseline.mjs');
    const optional = (name: string): string | undefined => {
      const value = parsed.options[name];
      return typeof value === 'string' && value.trim() ? value : undefined;
    };
    const written = await baseline.adoptBaseline({
      publishedSurfacePath: option('published-surface'),
      released: option('released'),
      reason: option('reason'),
      correcting: optional('correcting'),
      baselinePath: optional('baseline'),
      declarationPath: optional('declaration'),
    });
    printAnswer(written, parsed.options.json === true);
    return;
  }
  if (action === 'validate-manifest') {
    const verdict = await release.validateCandidateManifest({
      manifestPath: option('manifest'),
      sourceRevision: option('source-revision'),
      candidateTag: option('candidate-tag'),
    });
    printAnswer(verdict, parsed.options.json === true);
    return;
  }
  throw new Error(
    'weles release takes surface, enforce-version, validate-manifest or adopt-baseline, ' +
      `not ${action ?? '<nothing>'}`,
  );
}

/**
 * `weles design export-assets --provider figma --request <file>` exports
 * the inventory named in that request to its existing checkout. The request
 * also names the Git remote, branch and scoped credential acquisition inputs.
 * No organization, account, checkout or SSH key is selected by this command.
 *
 * `weles design parse-document --provider figma <document.json[.gz]>
 * <summary.json> <nodes.json> [<vocabulary.json>]` — the exporter's one parse
 * of a document, on its own, for a committed document whose export predates
 * its vocabulary. It reads no credential and reaches no network.
 *
 * The command is named for what it does; the design tool is `--provider`,
 * and Figma is the one implemented.
 */
const DESIGN_PROVIDER = 'figma';

export async function runDesign(parsed: ParsedCli): Promise<void> {
  const [action, ...paths] = parsed.positional;
  if (parsed.options.provider !== DESIGN_PROVIDER) {
    throw new UsageError(
      `design needs --provider naming the design tool; Weles implements ${DESIGN_PROVIDER}`,
    );
  }
  // The provider modules are ES modules and this CLI compiles to CommonJS,
  // which cannot static-import ESM.
  if (action === 'export-assets') {
    if (
      paths.length ||
      typeof parsed.options.request !== 'string' ||
      !parsed.options.request.trim()
    ) {
      throw new UsageError(
        'design export-assets requires --provider figma --request <export-request.json> and no positional paths',
      );
    }
    const exporter = await import('../figma/export-design-assets.mjs');
    await exporter.exportDesignAssets(parsed.options.request);
    return;
  }
  if (action === 'parse-document') {
    const parser = await import('../figma/document/parse-figma-document.mjs');
    if (paths.length < parser.REQUIRED_PATHS) {
      throw new UsageError(
        'weles design parse-document takes --provider figma <document.json[.gz]> <summary.json> <nodes.json> [<vocabulary.json>]',
      );
    }
    const [source, summaryPath, nodesPath, vocabularyPath] = paths;
    parser.parseFigmaDocument(source, summaryPath, nodesPath, vocabularyPath);
    return;
  }
  throw new UsageError(
    `weles design takes export-assets or parse-document, not ${action ?? '<nothing>'}`,
  );
}
