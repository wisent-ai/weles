#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importWelesTrajectoryFile } from './import.js';
import { runWelesOnboarding } from './onboarding.js';
import type { WelesOnboardingInput } from './onboarding.js';
import type { AsyncNewBrowserOptions } from './async_api.js';
import type { WelesImportReport } from './import.js';

type CliCommand = 'help' | 'version' | 'doctor' | 'open' | 'screenshot' | 'mcp' | 'onboarding' | 'import';

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
  weles open <url> [--headless] [--browser chromium|firefox] [--text] [--screenshot <file>] [--timeout <ms>]
  weles screenshot <url> <file> [--headless] [--browser chromium|firefox] [--timeout <ms>]
  weles mcp
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
  if (command === 'doctor' || command === 'open' || command === 'screenshot' || command === 'mcp' || command === 'onboarding' || command === 'import') return command;
  throw new Error(`unknown command: ${command}`);
}

function optionTakesValue(key: string): boolean {
  return ['browser', 'os', 'locale', 'chromium-path', 'user-data-dir', 'proxy', 'screenshot', 'timeout', 'subject', 'receipt', 'keys', 'state-dir', 'host'].includes(key);
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

function runDoctor(): void {
  const pkg = readPackageJson();
  const report = {
    ok: true,
    version: pkg.version ?? null,
    node: process.version,
    bin: pkg.bin ?? null,
    env: {
      CHROMIUM_PATH: process.env.CHROMIUM_PATH ? 'set' : 'unset',
      WELES_USE_STOCK_CHROMIUM: process.env.WELES_USE_STOCK_CHROMIUM ? 'set' : 'unset',
    },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
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
    runDoctor();
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
