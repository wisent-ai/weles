#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { WELES_AGENT_MODEL } from './agent/jeden.js';
import { importWelesTrajectoryFile } from './import.js';
import { runWelesOnboarding } from './onboarding.js';
import { resolveSkarbiecEndpoint } from './utils/endpoint-resolution.js';
import type { WelesOnboardingInput } from './onboarding.js';
import type { AsyncNewBrowserOptions } from './async_api.js';
import type { WelesImportReport } from './import.js';

type CliCommand = 'help' | 'version' | 'doctor' | 'open' | 'screenshot' | 'mcp' | 'onboarding' | 'import' | 'release' | 'figma';

type ParsedCli = {
  command: CliCommand;
  positional: string[];
  options: Record<string, string | boolean>;
};

const HELP = `Weles CLI

Usage:
  weles onboarding [status|next|import|verify|reset] [--subject <stable-id>]
  weles onboarding import <trajectory-export.json> --host <managed-worker-hostname> [--subject <stable-id>]
  weles onboarding verify --receipt <receipt.json> --keys <receipt-keys.json> [--subject <stable-id>]
  weles import <trajectory-export.json> --host <managed-worker-hostname>
  weles open <url> [--headless] [--browser chromium|firefox] [--wait-for-text <text>] [--text] [--screenshot <file>] [--timeout <ms>]
  weles screenshot <url> <file> [--headless] [--browser chromium|firefox] [--wait-for-text <text>] [--timeout <ms>]
  weles mcp
  weles release surface
  weles release enforce-version --decision <file> --baseline <file> --declaration <file> --manifest <file>
  weles release validate-manifest --manifest <file> --source-revision <sha> --candidate-tag <tag>
  weles figma export-design-assets
  weles doctor
  weles version

Options:
  --subject <stable-id>   Stable operator/device scope for durable onboarding progress.
  --receipt <file>        Real terminal Weles service receipt JSON to verify.
  --keys <file>           JSON map of trusted receipt key IDs to PEM public keys.
  --state-dir <dir>       Override the durable onboarding state directory.
  --host <hostname>       Exact managed Weles worker hostname for imported definitions.
  --headless              Launch without a visible browser window.
  --browser <name>        Browser engine passed to AsyncNewBrowser (default: chromium).
  --os <name>             Persona OS passed to AsyncNewBrowser (default: macos).
  --locale <locale>       Locale passed to AsyncNewBrowser.
  --chromium-path <path>  Custom Chromium binary path.
  --user-data-dir <dir>   Browser profile directory.
  --proxy <url>           Proxy server URL.
  --text                  Print document body text after navigation.
  --screenshot <file>     Save a screenshot after navigation.
  --wait-for-text <text>  Wait for matching visible text before reading or capturing.
  --timeout <ms>          Navigation timeout in milliseconds.

Onboarding explains the authorization boundary, optionally imports existing Weles
trajectory API exports, and explains approved host execution. Importing writes
host-bound drafts but does not launch browser automation or grant a new action.
Completion still requires cryptographic verification of a real workflow receipt
and its bound evidence digest.
`;

function readPackageJson(): { version?: string; bin?: unknown } {
  try {
    return JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version?: string; bin?: unknown };
  } catch {
    return {};
  }
}

let consoleRoutedToStderr = false;
function routeConsoleToStderr(): void {
  if (consoleRoutedToStderr) return;
  console.log = (...args: unknown[]) => console.error(...args);
  consoleRoutedToStderr = true;
}

export function usage(): string {
  return HELP;
}

export function parseCliArgs(argv: string[]): ParsedCli {
  const [rawCommand, ...rest] = argv;
  const command = normalizeCommand(rawCommand);
  const positional: string[] = [];
  const options: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const eq = arg.indexOf('=');
    if (eq !== -1) {
      const key = arg.slice(2, eq);
      options[key] = arg.slice(eq + 1);
      continue;
    }

    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith('--') && optionTakesValue(key)) {
      options[key] = next;
      i += 1;
    } else {
      options[key] = true;
    }
  }

  return { command, positional, options };
}

function normalizeCommand(command?: string): CliCommand {
  if (!command || command === '--help' || command === '-h' || command === 'help') return 'help';
  if (command === '--version' || command === '-v' || command === 'version') return 'version';
  if (command === 'doctor' || command === 'open' || command === 'screenshot' || command === 'mcp' || command === 'onboarding' || command === 'import' || command === 'release' || command === 'figma') return command;
  throw new Error(`unknown command: ${command}`);
}

function optionTakesValue(key: string): boolean {
  return ['browser', 'os', 'locale', 'chromium-path', 'user-data-dir', 'proxy', 'screenshot', 'wait-for-text', 'timeout', 'subject', 'receipt', 'keys', 'state-dir', 'host', 'decision', 'baseline', 'declaration', 'manifest', 'source-revision', 'candidate-tag'].includes(key);
}

function cliOptionsToBrowserOptions(options: Record<string, string | boolean>): AsyncNewBrowserOptions {
  const browserOptions: AsyncNewBrowserOptions = {
    headless: options.headless === true,
  };
  if (typeof options.browser === 'string') browserOptions.browser = options.browser;
  if (typeof options.os === 'string') browserOptions.os = options.os;
  if (typeof options.locale === 'string') browserOptions.locale = options.locale;
  if (typeof options['chromium-path'] === 'string') browserOptions.chromiumPath = options['chromium-path'];
  if (typeof options['user-data-dir'] === 'string') browserOptions.userDataDir = options['user-data-dir'];
  if (typeof options.proxy === 'string') browserOptions.proxy = { server: options.proxy };
  return browserOptions;
}

function parseTimeout(options: Record<string, string | boolean>): number | undefined {
  if (typeof options.timeout !== 'string') return undefined;
  const timeout = Number(options.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error(`invalid --timeout: ${options.timeout}`);
  return timeout;
}

async function runOpen(parsed: ParsedCli): Promise<void> {
  const [url] = parsed.positional;
  if (!url) throw new Error('open requires <url>');

  routeConsoleToStderr();
  const { AsyncNewBrowser } = await import('./async_api.js');
  const context = await AsyncNewBrowser(cliOptionsToBrowserOptions(parsed.options));
  try {
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: parseTimeout(parsed.options) });
    if (typeof parsed.options['wait-for-text'] === 'string') {
      await page.getByText(parsed.options['wait-for-text'], { exact: false }).first().waitFor({
        state: 'visible',
        timeout: parseTimeout(parsed.options),
      });
    }
    const title = await page.title().catch(() => '');
    const out: Record<string, unknown> = {
      ok: true,
      url: page.url(),
      title,
      status: response?.status() ?? null,
    };

    if (typeof parsed.options.screenshot === 'string') {
      await page.screenshot({ path: parsed.options.screenshot, fullPage: true });
      out.screenshot = parsed.options.screenshot;
    }
    if (parsed.options.text === true) {
      out.text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    }

    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function runScreenshot(parsed: ParsedCli): Promise<void> {
  const [url, file] = parsed.positional;
  if (!url || !file) throw new Error('screenshot requires <url> <file>');
  parsed.options.screenshot = file;
  await runOpen(parsed);
}

async function runDoctor(): Promise<void> {

  const pkg = readPackageJson();
  const report: Record<string, unknown> = {
    ok: true,
    version: pkg.version ?? null,
    node: process.version,
    bin: pkg.bin ?? null,
    env: {
      CHROMIUM_PATH: process.env.CHROMIUM_PATH ? 'set' : 'unset',
      WELES_USE_STOCK_CHROMIUM: process.env.WELES_USE_STOCK_CHROMIUM ? 'set' : 'unset',
    },
    dependencies: {
      skarbiec: null as unknown,
      browserRuntime: null as unknown,
    },
  };

  try {
    const skarbiecResult = await resolveSkarbiecEndpoint();
    if (skarbiecResult.resolved) {
      report.dependencies = {
        skarbiec: {
          resolved: skarbiecResult.resolved.url,
          source: skarbiecResult.resolved.source,
          sourceDetail: skarbiecResult.resolved.sourceDetail,
          isListening: skarbiecResult.resolved.isListening,
        },
      };
      if (!skarbiecResult.resolved.isListening) {
        report.ok = false;
      }
    }
  } catch (error) {
    report.dependencies = {
      skarbiec: {
        error: error instanceof Error ? error.message : String(error),
      },
    };
    report.ok = false;
  }

  // A worker that will die on its first browser task should say so here
  // rather than at the fourth failed job. `browserContext.newPage` needs the
  // recording dependency before it will open a page at all, so an absent
  // ffmpeg is not a degraded run, it is every browser task on the host
  // failing -- and it reported itself only as a run failure hours later.
  const runtime = inspectBrowserRuntime();
  report.dependencies = {
    ...(report.dependencies as Record<string, unknown>),
    browserRuntime: runtime,
  };
  if (!runtime.ok) {
    report.ok = false;
  }

  // Which revision this host actually built, against the revision the
  // deployment declares, and the Brama alias that revision will ask for. On
  // 2026-09-06 the managed runtime was three weeks behind its own repository
  // and asked Brama for `best`, a subscription route whose credentials had
  // lapsed, so every browser task on the host failed while the host's own
  // bearer was being served. Nothing reported the gap: `doctor` said the
  // version in `package.json`, which is the repository's, not the runtime's.
  const managed = inspectManagedRuntime();
  report.managedRuntime = managed;
  if (!managed.ok) {
    report.ok = false;
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

type ManagedRuntimeReport = {
  ok: boolean;
  root: string;
  builtRevision: string | null;
  declaredRevision: string | null;
  agentModelAlias: string;
  detail?: string;
};

/// What the managed Weles API runtime on this host was built from, and which
/// Brama alias it will ask for.
///
/// The runtime is one checkout under `~/.stado/build-work/weles-api-managed`
/// whose revision the deployment records in `.weles-api-revision`, and
/// `stado host weles-api-runtime` is what moves it. The declared revision is
/// the one the deployment left in `WELES_API_DECLARED_REVISION` on the unit;
/// when the two disagree, the host is serving code nobody declared, which is
/// how a 2026-08-30 build kept asking Brama for `best` a week after the fix
/// that renamed the alias — every browser task on the host failed while the
/// host's own bearer was being served, and `doctor` reported the repository's
/// `package.json` version, which is not the runtime's.
function inspectManagedRuntime(): ManagedRuntimeReport {
  const root = join(homedir(), '.stado', 'build-work', 'weles-api-managed');
  const alias = process.env.WELES_AGENT_MODEL?.trim() || WELES_AGENT_MODEL;
  const builtRevision = readRevisionMarker(join(root, '.weles-api-revision'));
  const declaredRevision = revision(process.env.WELES_API_DECLARED_REVISION);
  if (!builtRevision) {
    return {
      ok: true,
      root,
      builtRevision: null,
      declaredRevision,
      agentModelAlias: alias,
      detail: 'this host runs no managed Weles API runtime',
    };
  }
  if (!declaredRevision) {
    return {
      ok: true,
      root,
      builtRevision,
      declaredRevision: null,
      agentModelAlias: alias,
      detail: 'the unit declares no revision, so this reports what is installed and compares nothing',
    };
  }
  if (builtRevision !== declaredRevision) {
    return {
      ok: false,
      root,
      builtRevision,
      declaredRevision,
      agentModelAlias: alias,
      detail: `the installed runtime is ${builtRevision.slice(0, 12)} and the unit declares ${declaredRevision.slice(0, 12)}; move it with \`stado host weles-api-runtime <host> --revision ${declaredRevision.slice(0, 12)}\``,
    };
  }
  return { ok: true, root, builtRevision, declaredRevision, agentModelAlias: alias };
}

function revision(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return /^[0-9a-f]{40}$/.test(trimmed) ? trimmed : null;
}

function readRevisionMarker(path: string): string | null {
  try {
    return revision(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/// The components this worker takes from Playwright's own cache.
///
/// Not every browser Playwright pins: the worker launches its own Chromium
/// and Firefox releases, pinned by digest, so Playwright's bundled browsers
/// are absent on a healthy host. `ffmpeg` is what the recording path uses and
/// what its absence breaks.
const REQUIRED_PLAYWRIGHT_COMPONENTS = ['ffmpeg'] as const;

type BrowserRuntimeReport = {
  ok: boolean;
  components?: Array<{ name: string; revision: string; expectedPath: string; present: boolean }>;
  error?: string;
};

/// Whether the browser runtime this release pins is actually on disk.
///
/// The revisions are read from the Playwright the release itself carries,
/// never hardcoded: the cache directory is `<name>-<revision>` with
/// underscores for hyphenated names, so a constant would check the wrong path
/// the moment the dependency moved. Presence is Playwright's own
/// `INSTALLATION_COMPLETE` marker, so a directory left behind by an
/// interrupted download is reported missing rather than present.
function inspectBrowserRuntime(): BrowserRuntimeReport {
  let declared: Array<{ name: string; revision: string }>;
  try {
    // Resolved through the package's main entry and then walked up to the
    // manifest beside it. `require.resolve('playwright-core/browsers.json')`
    // is refused: the package's `exports` map does not publish that subpath,
    // even though the file is what Playwright itself reads for its revisions.
    // Asking the resolver for the entry point and walking from there uses the
    // same copy the runtime will load, which a hardcoded node_modules path
    // would not.
    const manifestPath = findPlaywrightManifest();
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      browsers?: Array<{ name?: string; revision?: string }>;
    };
    declared = (parsed.browsers ?? [])
      .filter((entry): entry is { name: string; revision: string } =>
        typeof entry.name === 'string' && typeof entry.revision === 'string')
      .map((entry) => ({ name: entry.name, revision: entry.revision }));
  } catch (error) {
    return {
      ok: false,
      error: `cannot read playwright-core/browsers.json, so the browser runtime this release needs is unknown: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const cacheRoot = playwrightCacheRoot();
  const components = REQUIRED_PLAYWRIGHT_COMPONENTS.map((name) => {
    const found = declared.find((entry) => entry.name === name);
    const revision = found?.revision ?? 'unknown';
    const expectedPath = join(cacheRoot, `${name.replace(/-/g, '_')}-${revision}`, 'INSTALLATION_COMPLETE');
    return { name, revision, expectedPath, present: found ? existsSync(expectedPath) : false };
  });
  return { ok: components.every((component) => component.present), components };
}

/// The `browsers.json` beside the resolved `playwright-core`.
function findPlaywrightManifest(): string {
  let directory = dirname(require.resolve('playwright-core'));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, 'browsers.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('no browsers.json beside the resolved playwright-core');
}

/// Where Playwright keeps its downloads on this platform.
function playwrightCacheRoot(): string {
  const override = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (override) return override;
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return join(home, 'AppData', 'Local', 'ms-playwright');
  return join(home, '.cache', 'ms-playwright');
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

async function runImport(parsed: ParsedCli): Promise<void> {
  const report = await executeImport(parsed);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function isOnboardingAction(value: string): value is NonNullable<WelesOnboardingInput['action']> {
  return value === 'status' || value === 'next' || value === 'verify' || value === 'reset';
}

async function runOnboarding(parsed: ParsedCli): Promise<void> {
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
 * `weles release <surface|enforce-version|validate-manifest>` — the three
 * judgements the release pipeline asks this product to make about itself.
 */
async function runRelease(parsed: ParsedCli): Promise<void> {
  // The release judgements are ES modules and this CLI compiles to CommonJS,
  // which cannot static-import ESM: `await import()` is the only load that
  // works, not a preference.
  const release = await import('./release/index.mjs');
  const [action] = parsed.positional;
  const option = (name: string): string => {
    const value = parsed.options[name];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} is required`);
    return value;
  };
  if (action === 'surface') {
    process.stdout.write(`${JSON.stringify(await release.surface(), null, 2)}\n`);
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
  if (action === 'validate-manifest') {
    const verdict = await release.validateCandidateManifest({
      manifestPath: option('manifest'),
      sourceRevision: option('source-revision'),
      candidateTag: option('candidate-tag'),
    });
    process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
    return;
  }
  throw new Error(`weles release takes surface, enforce-version or validate-manifest, not ${action ?? '<nothing>'}`);
}

/**
 * `weles figma export-design-assets` — export the Figma design files this
 * organization owns and publish them to the design-assets repository. The
 * exporter reads its Figma credential through the fleet's Skarbiec endpoint,
 * which is why `WC_SKARBIEC_URL` is the one coordinate it still takes from the
 * environment.
 */
async function runFigma(parsed: ParsedCli): Promise<void> {
  const [action] = parsed.positional;
  if (action !== 'export-design-assets') {
    throw new Error(`weles figma takes export-design-assets, not ${action ?? '<nothing>'}`);
  }
  // The exporter is an ES module and this CLI compiles to CommonJS, which
  // cannot static-import ESM.
  await import('./figma/export-design-assets.mjs');
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseCliArgs(argv);
  if (parsed.command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (parsed.command === 'version') {
    process.stdout.write(`${readPackageJson().version ?? 'unknown'}\n`);
    return;
  }
  if (parsed.command === 'doctor') {
    await runDoctor();
    return;
  }
  if (parsed.command === 'open') {
    await runOpen(parsed);
    return;
  }
  if (parsed.command === 'screenshot') {
    await runScreenshot(parsed);
    return;
  }
  if (parsed.command === 'import') {
    await runImport(parsed);
    return;
  }
  if (parsed.command === 'onboarding') {
    await runOnboarding(parsed);
    return;
  }
  if (parsed.command === 'release') {
    await runRelease(parsed);
    return;
  }
  if (parsed.command === 'figma') {
    await runFigma(parsed);
    return;
  }
  if (parsed.command === 'mcp') {
    const { startMcpServer } = await import('./mcp.js');
    startMcpServer();
  }
}

if (require.main === module) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`weles: ${message}\n`);
    process.exitCode = 1;
  });
}
