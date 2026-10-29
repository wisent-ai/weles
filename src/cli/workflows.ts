import { readFileSync } from 'node:fs';
import {
  importWelesTrajectoryFile,
  type WelesImportReport,
} from '../runtime/import.js';
import { runWelesOnboarding } from '../onboarding/first-use.js';
import type { WelesOnboardingInput } from '../onboarding/view/view.js';
import type { ParsedCli } from '../cli.js';
import { exitStatusFor, printAnswer, UsageError } from './usage.js';

type Handler = (parsed: ParsedCli) => Promise<void>;

/** The handler for the verb the caller named; no verb is assumed, and an unknown one is refused naming the verbs. */
function verbHandler(
  command: string,
  verbs: Record<string, Handler>,
  verb: string | undefined,
): Handler {
  const known = Object.keys(verbs).join(', ');
  if (verb === undefined)
    throw new UsageError(`weles ${command} needs an action: ${known}`);
  if (!Object.hasOwn(verbs, verb))
    throw new UsageError(`weles ${command} takes ${known}, not ${verb}`);
  return verbs[verb];
}

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
  if (!entries.length) throw new Error('receipt key map must not be empty');
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
  const [path, extra] = parsed.positional;
  if (!path || extra !== undefined)
    throw new UsageError('import requires <trajectory-export.json>');
  if (typeof parsed.options.host !== 'string')
    throw new UsageError('import requires --host <managed-worker-hostname>');
  const report = await importWelesTrajectoryFile(path, parsed.options.host);
  // A refused row is a refusal of a well-formed import, so it exits as a
  // failure rather than as a usage error.
  if (report.refused)
    process.exitCode = exitStatusFor(
      new Error(`the import refused ${report.refused} rows`),
    );
  return report;
}

export async function runImport(parsed: ParsedCli): Promise<void> {
  const report = await executeImport(parsed);
  printAnswer(report, parsed.options.json === true);
}

/** The subject and state directory every onboarding verb reads. */
function onboardingScope(parsed: ParsedCli) {
  return {
    subject:
      typeof parsed.options.subject === 'string'
        ? parsed.options.subject
        : undefined,
    stateDirectory:
      typeof parsed.options['state-dir'] === 'string'
        ? parsed.options['state-dir']
        : undefined,
  };
}

async function onboardingImport(parsed: ParsedCli): Promise<void> {
  const [, file, extra] = parsed.positional;
  if (!file || extra !== undefined)
    throw new UsageError('onboarding import requires <trajectory-export.json>');
  const scope = onboardingScope(parsed);
  const before = await runWelesOnboarding({ action: 'status', ...scope });
  if (before.screen.id !== 'existing-data') {
    throw new Error(
      'complete the authorization-boundary step before importing existing data',
    );
  }
  const report = await executeImport({
    ...parsed,
    command: 'import',
    positional: [file],
  });
  if (!(report.imported + report.unchanged)) {
    printAnswer(
      { import: report, onboarding: before },
      parsed.options.json === true,
    );
    return;
  }
  const view = await runWelesOnboarding({
    action: 'import',
    importReport: report,
    ...scope,
  });
  printAnswer(
    { import: report, onboarding: view },
    parsed.options.json === true,
  );
}

/** An onboarding verb that takes no path: it reads the journey, or verifies a receipt. */
function onboardingStep(
  action: NonNullable<WelesOnboardingInput['action']>,
): Handler {
  return async (parsed) => {
    const [, extra] = parsed.positional;
    if (extra !== undefined)
      throw new UsageError(`onboarding ${action} takes no positional argument`);
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
      ...onboardingScope(parsed),
      receipt,
      receiptKeys:
        typeof keysPath === 'string' ? readReceiptKeys(keysPath) : undefined,
    });
    printAnswer(view, parsed.options.json === true);
  };
}

/** What `weles onboarding` can do, by the verb the caller names. */
const ONBOARDING_ACTIONS: Record<string, Handler> = {
  status: onboardingStep('status'),
  next: onboardingStep('next'),
  import: onboardingImport,
  verify: onboardingStep('verify'),
  reset: onboardingStep('reset'),
};

export async function runOnboarding(parsed: ParsedCli): Promise<void> {
  const [action] = parsed.positional;
  return verbHandler('onboarding', ONBOARDING_ACTIONS, action)(parsed);
}

/** A non-empty `--name` value, refused by name when missing. */
function requiredOption(parsed: ParsedCli, name: string): string {
  const value = parsed.options[name];
  if (typeof value !== 'string' || !value.trim())
    throw new UsageError(`--${name} is required`);
  return value;
}

/** A `--name` value when the caller gave a non-empty one. */
function optionalOption(parsed: ParsedCli, name: string): string | undefined {
  const value = parsed.options[name];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

// The release judgements are ES modules and this CLI compiles to CommonJS,
// which cannot static-import ESM: `await import()` is the only load that
// works, not a preference.
const RELEASE_ACTIONS: Record<string, Handler> = {
  // `--root` reads the surface of another tree, which is how the surface a
  // published release exposes is recovered: extract that release's source
  // revision and read it with today's reader, rather than trusting a
  // document the build wrote when the reader was broken.
  surface: async (parsed) => {
    const release = await import('../release/index.mjs');
    process.stdout.write(
      `${JSON.stringify(await release.surface(optionalOption(parsed, 'root')), null, 2)}\n`,
    );
  },
  enforce: async (parsed) => {
    const release = await import('../release/index.mjs');
    const inputs = await release.readVersionInputs({
      decision: requiredOption(parsed, 'decision'),
      baseline: requiredOption(parsed, 'baseline'),
      declaration: requiredOption(parsed, 'declaration'),
      manifest: requiredOption(parsed, 'manifest'),
    });
    printAnswer(release.enforceVersion(inputs), parsed.options.json === true);
  },
  validate: async (parsed) => {
    const release = await import('../release/index.mjs');
    const verdict = await release.validateCandidateManifest({
      manifestPath: requiredOption(parsed, 'manifest'),
      sourceRevision: requiredOption(parsed, 'source-revision'),
      candidateTag: requiredOption(parsed, 'candidate-tag'),
    });
    printAnswer(verdict, parsed.options.json === true);
  },
  adopt: async (parsed) => {
    const baseline = await import('../release/baseline.mjs');
    const written = await baseline.adoptBaseline({
      publishedSurfacePath: requiredOption(parsed, 'published-surface'),
      released: requiredOption(parsed, 'released'),
      reason: requiredOption(parsed, 'reason'),
      correcting: optionalOption(parsed, 'correcting'),
      baselinePath: optionalOption(parsed, 'baseline'),
      declarationPath: optionalOption(parsed, 'declaration'),
    });
    printAnswer(written, parsed.options.json === true);
  },
};

/**
 * `weles release <surface|enforce|validate|adopt>` —
 * the judgements the release pipeline asks this product to make about itself,
 * and the write-back that keeps the documents those judgements read truthful.
 */
export async function runRelease(parsed: ParsedCli): Promise<void> {
  const [action] = parsed.positional;
  return verbHandler('release', RELEASE_ACTIONS, action)(parsed);
}

/**
 * `weles design export --provider figma --request <file>` exports
 * the inventory named in that request to its existing checkout. The request
 * also names the Git remote, branch and scoped credential acquisition inputs.
 * No organization, account, checkout or SSH key is selected by this command.
 *
 * `weles design parse --provider figma <document.json[.gz]>
 * <summary.json> <nodes.json> [<vocabulary.json>]` — the exporter's one parse
 * of a document, on its own, for a committed document whose export predates
 * its vocabulary. It reads no credential and reaches no network.
 *
 * The command is named for what it does; the design tool is `--provider`,
 * and Figma is the one implemented.
 */
const DESIGN_PROVIDER = 'figma';

// The provider modules are ES modules and this CLI compiles to CommonJS,
// which cannot static-import ESM.
const DESIGN_ACTIONS: Record<string, Handler> = {
  export: async (parsed) => {
    const [, ...paths] = parsed.positional;
    const request = optionalOption(parsed, 'request');
    if (paths.length || !request) {
      throw new UsageError(
        'design export requires --provider figma --request <export-request.json> and no positional paths',
      );
    }
    const exporter = await import('../figma/export-design-assets.mjs');
    await exporter.exportDesignAssets(request);
  },
  parse: async (parsed) => {
    const [, ...paths] = parsed.positional;
    const parser = await import('../figma/document/parse-figma-document.mjs');
    if (paths.length < parser.REQUIRED_PATHS) {
      throw new UsageError(
        'weles design parse takes --provider figma <document.json[.gz]> <summary.json> <nodes.json> [<vocabulary.json>]',
      );
    }
    const [source, summaryPath, nodesPath, vocabularyPath] = paths;
    parser.parseFigmaDocument(source, summaryPath, nodesPath, vocabularyPath);
  },
};

export async function runDesign(parsed: ParsedCli): Promise<void> {
  if (parsed.options.provider !== DESIGN_PROVIDER) {
    throw new UsageError(
      `design needs --provider naming the design tool; Weles implements ${DESIGN_PROVIDER}`,
    );
  }
  const [action] = parsed.positional;
  return verbHandler('design', DESIGN_ACTIONS, action)(parsed);
}
