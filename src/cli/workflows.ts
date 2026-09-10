import { readFileSync } from 'node:fs';
import { importWelesTrajectoryFile, type WelesImportReport } from '../runtime/import.js';
import { runWelesOnboarding, type WelesOnboardingInput } from '../onboarding/first-use.js';
import type { ParsedCli } from '../cli.js';
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
  if (entries.length === 0) throw new Error('receipt key map must not be empty');
  const keys: Record<string, string> = {};
  for (const [key, publicKey] of entries) {
    if (!key || typeof publicKey !== 'string' || !publicKey.trim()) {
      throw new Error('receipt key map must contain non-empty key IDs and PEM public keys');
    }
    keys[key] = publicKey;
  }
  return keys;
}

async function executeImport(parsed: ParsedCli): Promise<WelesImportReport> {
  const [path] = parsed.positional;
  if (!path || parsed.positional.length !== 1) throw new Error('import requires <trajectory-export.json>');
  if (typeof parsed.options.host !== 'string') throw new Error('import requires --host <managed-worker-hostname>');
  const report = await importWelesTrajectoryFile(path, parsed.options.host);
  if (report.refused > 0) process.exitCode = 2;
  return report;
}

export async function runImport(parsed: ParsedCli): Promise<void> {
  const report = await executeImport(parsed);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function isOnboardingAction(value: string): value is NonNullable<WelesOnboardingInput['action']> {
  return value === 'status' || value === 'next' || value === 'verify' || value === 'reset';
}

export async function runOnboarding(parsed: ParsedCli): Promise<void> {
  const action = parsed.positional[0] ?? 'status';
  if (action === 'import') {
    if (parsed.positional.length !== 2) {
      throw new Error('onboarding import requires <trajectory-export.json>');
    }
    const common = {
      subject: typeof parsed.options.subject === 'string' ? parsed.options.subject : undefined,
      stateDirectory: typeof parsed.options['state-dir'] === 'string' ? parsed.options['state-dir'] : undefined,
    };
    const before = await runWelesOnboarding({ action: 'status', ...common });
    if (before.screen.id !== 'existing-data') {
      throw new Error('complete the authorization-boundary step before importing existing data');
    }
    const report = await executeImport({ ...parsed, command: 'import', positional: parsed.positional.slice(1) });
    if (report.imported + report.unchanged === 0) {
      process.stdout.write(`${JSON.stringify({ import: report, onboarding: before }, null, 2)}\n`);
      return;
    }
    const view = await runWelesOnboarding({ action: 'import', importReport: report, ...common });
    process.stdout.write(`${JSON.stringify({ import: report, onboarding: view }, null, 2)}\n`);
    return;
  }
  if (!isOnboardingAction(action) || parsed.positional.length > 1) {
    throw new Error('onboarding action must be status, next, import, verify, or reset');
  }
  const receiptPath = parsed.options.receipt;
  const keysPath = parsed.options.keys;
  if (action === 'verify' && (typeof receiptPath !== 'string' || typeof keysPath !== 'string')) {
    throw new Error('onboarding verify requires --receipt <file> and --keys <file>');
  }
  const receiptDocument = typeof receiptPath === 'string' ? readJsonFile(receiptPath, 'workflow receipt') : undefined;
  const receipt = receiptDocument && typeof receiptDocument === 'object' && 'receipt' in receiptDocument
    ? receiptDocument.receipt
    : receiptDocument;
  const view = await runWelesOnboarding({
    action,
    subject: typeof parsed.options.subject === 'string' ? parsed.options.subject : undefined,
    stateDirectory: typeof parsed.options['state-dir'] === 'string' ? parsed.options['state-dir'] : undefined,
    receipt,
    receiptKeys: typeof keysPath === 'string' ? readReceiptKeys(keysPath) : undefined,
  });
  process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
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
    if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} is required`);
    return value;
  };
  if (action === 'surface') {
    // `--root` reads the surface of another tree, which is how the surface a
    // published release exposes is recovered: extract that release's source
    // revision and read it with today's reader, rather than trusting a
    // document the build wrote when the reader was broken.
    const root = typeof parsed.options.root === 'string' && parsed.options.root.trim()
      ? parsed.options.root
      : undefined;
    process.stdout.write(`${JSON.stringify(await release.surface(root), null, 2)}\n`);
    return;
  }
  if (action === 'enforce-version') {
    const inputs = await release.readVersionInputs({
      decision: option('decision'),
      baseline: option('baseline'),
      declaration: option('declaration'),
      manifest: option('manifest'),
    });
    process.stdout.write(`${JSON.stringify(release.enforceVersion(inputs), null, 2)}\n`);
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
    process.stdout.write(`${JSON.stringify(written, null, 2)}\n`);
    return;
  }
  if (action === 'validate-manifest') {
    const verdict = await release.validateCandidateManifest({
      manifestPath: option('manifest'),
      sourceRevision: option('source-revision'),
      candidateTag: option('candidate-tag'),
    });
    process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
    return;
  }
  throw new Error(
    'weles release takes surface, enforce-version, validate-manifest or adopt-baseline, '
    + `not ${action ?? '<nothing>'}`,
  );
}

/**
 * `weles figma export-design-assets` — export the Figma design files this
 * organization owns and publish them to the design-assets repository. The
 * exporter reads its Figma credential through the fleet's Skarbiec endpoint,
 * which is why `WC_SKARBIEC_URL` is the one coordinate it still takes from the
 * environment.
 */
export async function runFigma(parsed: ParsedCli): Promise<void> {
  const [action] = parsed.positional;
  if (action !== 'export-design-assets') {
    throw new Error(`weles figma takes export-design-assets, not ${action ?? '<nothing>'}`);
  }
  // The exporter is an ES module and this CLI compiles to CommonJS, which
  // cannot static-import ESM.
  await import('../figma/export-design-assets.mjs');
}
