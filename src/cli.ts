#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AsyncNewBrowserOptions } from './async_api.js';
import { runDoctor } from './cli/diagnostics.js';
import { runImport, runOnboarding, runRelease, runFigma } from './cli/workflows.js';

type CliCommand = 'help' | 'version' | 'doctor' | 'open' | 'screenshot' | 'mcp' | 'onboarding' | 'import' | 'release' | 'figma';

export type ParsedCli = {
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
  weles release surface [--root <directory>]
  weles release enforce-version --decision <file> --baseline <file> --declaration <file> --manifest <file>
  weles release validate-manifest --manifest <file> --source-revision <sha> --candidate-tag <tag>
  weles release adopt-baseline --released <version> --published-surface <file> --reason <text> [--correcting <version>]
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
  return ['browser', 'os', 'locale', 'chromium-path', 'user-data-dir', 'proxy', 'screenshot', 'wait-for-text', 'timeout', 'subject', 'receipt', 'keys', 'state-dir', 'host', 'decision', 'baseline', 'declaration', 'manifest', 'source-revision', 'candidate-tag', 'released', 'published-surface', 'reason', 'correcting', 'root'].includes(key);
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
    await runDoctor(readPackageJson());
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
