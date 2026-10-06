#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AsyncNewBrowserOptions } from './async_api.js';
import { runDoctor } from './cli/diagnostics.js';
import { runImport, runOnboarding, runRelease, runDesign } from './cli/workflows.js';
import { runOperatorRequests } from './cli/operator-requests.js';
import { runAccountSecurity } from './cli/security/account-security.js';
import { runAppPassword } from './cli/security/app-password.js';
import { runAppleDeveloperId } from './cli/security/apple-developer-id.js';
import { runAppleLogin } from './cli/security/apple-login.js';
import { runWorker } from './cli/worker/index.js';
import { runKeeper } from './cli/keeper.js';
import { adoptRecords } from './state/skarbiec-records.js';
import { HELP, UsageError, exitStatusFor, printAnswer } from './cli/usage.js';

type CliCommand = 'help' | 'version' | 'doctor' | 'open' | 'screenshot' | 'mcp' | 'onboarding' | 'import' | 'release' | 'design' | 'operator-requests' | 'account-security' | 'app-password' | 'developer-certificate' | 'login' | 'worker' | 'records' | 'keeper';

export type ParsedCli = {
  command: CliCommand;
  positional: string[];
  options: Record<string, string | boolean>;
};

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
  if (command === 'account-security' || command === 'app-password' || command === 'developer-certificate' || command === 'login' || command === 'worker' || command === 'records' || command === 'keeper') return command;
  if (command === 'doctor' || command === 'open' || command === 'screenshot' || command === 'mcp' || command === 'onboarding' || command === 'import' || command === 'release' || command === 'design' || command === 'operator-requests') return command;
  throw new UsageError(`unknown command: ${command}`);
}

function optionTakesValue(key: string): boolean {
  if (key === 'login-item' || key === 'login-role') return true;
  return ['browser', 'os', 'locale', 'user-data-dir', 'proxy', 'screenshot', 'wait-for-text', 'subject', 'receipt', 'keys', 'state-dir', 'host', 'decision', 'baseline', 'declaration', 'manifest', 'source-revision', 'candidate-tag', 'released', 'published-surface', 'reason', 'correcting', 'root', 'limit', 'kind', 'account', 'run', 'instruction', 'pid', 'detail', 'account-role', 'confirm', 'execution-host', 'execution-agent', 'private-key-out', 'certificate-out', 'expires-in-minutes', 'private-key', 'store-host', 'session', 'url', 'provider', 'organization', 'request'].includes(key);
}

function cliOptionsToBrowserOptions(options: Record<string, string | boolean>): AsyncNewBrowserOptions {
  const browserOptions: AsyncNewBrowserOptions = {
    headless: options.headless === true,
  };
  if (typeof options.browser === 'string') browserOptions.browser = options.browser;
  if (typeof options.os === 'string') browserOptions.os = options.os;
  if (typeof options.locale === 'string') browserOptions.locale = options.locale;
  if (typeof options['user-data-dir'] === 'string') browserOptions.userDataDir = options['user-data-dir'];
  if (typeof options.proxy === 'string') browserOptions.proxy = { server: options.proxy };
  return browserOptions;
}

async function runOpen(parsed: ParsedCli): Promise<void> {
  const [url] = parsed.positional;
  if (!url) throw new UsageError('open requires <url>');
  routeConsoleToStderr();
  const { AsyncNewBrowser } = await import('./async_api.js');
  const context = await AsyncNewBrowser(cliOptionsToBrowserOptions(parsed.options));
  let out: Record<string, unknown> | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (typeof parsed.options['wait-for-text'] === 'string') {
      await page.getByText(parsed.options['wait-for-text'], { exact: false }).first().waitFor({ state: 'visible' });
    }
    const title = await page.title();
    out = {
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
      out.text = await page.locator('body').innerText();
    }

  } catch (error) {
    operationError = error;
    operationFailed = true;
    throw error;
  } finally {
    try {
      await context.close();
    } catch (closeError) {
      const closeDetail = closeError instanceof Error ? closeError.message : String(closeError);
      if (operationFailed) {
        const operationDetail = operationError instanceof Error ? operationError.message : String(operationError);
        throw new AggregateError([operationError, closeError],
          `${parsed.command} failed: ${operationDetail}; browser close failed: ${closeDetail}`);
      }
      throw new Error(`closing browser after ${parsed.command} failed: ${closeDetail}`, { cause: closeError });
    }
  }
  if (!out) throw new Error(`${parsed.command} completed without a navigation result`);
  printAnswer(out, parsed.options.json === true);
}

async function runScreenshot(parsed: ParsedCli): Promise<void> {
  const [url, file] = parsed.positional;
  if (!url || !file) throw new UsageError('screenshot requires <url> <file>');
  parsed.options.screenshot = file;
  await runOpen(parsed);
}



export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseCliArgs(argv);
  if (parsed.command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  // `--help` or `-h` after a command answers with that command's usage lines
  // from HELP and never runs it: `weles open --help` used to fail with
  // "open requires <url>".
  if (parsed.options.help === true || parsed.positional.includes('-h')) {
    const prefix = `  weles ${parsed.command}`;
    const lines = HELP.split('\n').filter((line) => line === prefix || line.startsWith(`${prefix} `));
    process.stdout.write(lines.length === 0 ? HELP : `Usage:\n${lines.join('\n')}\n`);
    return;
  }
  if (parsed.command === 'version') {
    process.stdout.write(`${readPackageJson().version ?? 'unknown'}\n`);
    return;
  }
  if (parsed.command === 'doctor') {
    await runDoctor(readPackageJson(), parsed.options.json === true);
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
  if (parsed.command === 'design') {
    await runDesign(parsed);
    return;
  }
  if (parsed.command === 'operator-requests') {
    await runOperatorRequests(parsed);
    return;
  }
  if (parsed.command === 'account-security') {
    await runAccountSecurity(parsed);
    return;
  }
  if (parsed.command === 'app-password') {
    await runAppPassword(parsed);
    return;
  }
  if (parsed.command === 'developer-certificate') {
    await runAppleDeveloperId(parsed);
    return;
  }
  if (parsed.command === 'login') {
    await runAppleLogin(parsed);
    return;
  }
  if (parsed.command === 'worker') {
    await runWorker(parsed);
    return;
  }
  if (parsed.command === 'keeper') {
    await runKeeper(parsed);
    return;
  }
  if (parsed.command === 'records') {
    if (parsed.positional.join(' ') !== 'adopt' || Object.keys(parsed.options).some((key) => key !== 'json')) {
      throw new UsageError('records takes exactly: adopt [--json]');
    }
    printAnswer(adoptRecords(), parsed.options.json === true);
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
    process.exitCode = exitStatusFor(error);
  });
}
