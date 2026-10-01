#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AsyncNewBrowserOptions } from './async_api.js';
import { runDoctor } from './cli/diagnostics.js';
import { runImport, runOnboarding, runRelease, runFigma } from './cli/workflows.js';
import { runOperatorRequests } from './cli/operator-requests.js';
import { runAccountSecurity } from './cli/security/account-security.js';
import { runAppPassword } from './cli/security/app-password.js';
import { runAppleDeveloperId } from './cli/security/apple-developer-id.js';
import { runAppleLogin } from './cli/security/apple-login.js';
import { runWorker } from './cli/worker/index.js';
import { runKeeper } from './cli/keeper.js';
import { adoptRecords } from './state/skarbiec-records.js';
import { UsageError, exitStatusFor, printAnswer } from './cli/usage.js';

type CliCommand = 'help' | 'version' | 'doctor' | 'open' | 'screenshot' | 'mcp' | 'onboarding' | 'import' | 'release' | 'figma' | 'operator-requests' | 'account-security' | 'app-password' | 'apple-developer-id' | 'apple-login' | 'worker' | 'records' | 'keeper';

export type ParsedCli = {
  command: CliCommand;
  positional: string[];
  options: Record<string, string | boolean>;
};

const HELP = `Weles CLI

Usage:
  weles onboarding [status|next|import|verify|reset] [--subject <stable-id>] [--json]
  weles onboarding import <trajectory-export.json> --host <managed-worker-hostname> [--subject <stable-id>] [--json]
  weles onboarding verify --receipt <receipt.json> --keys <receipt-keys.json> [--subject <stable-id>] [--json]
  weles import <trajectory-export.json> --host <managed-worker-hostname> [--json]
  weles open <url> [--headless] [--browser chromium|firefox] [--wait-for-text <text>] [--text] [--screenshot <file>] [--json]
  weles screenshot <url> <file> [--headless] [--browser chromium|firefox] [--wait-for-text <text>] [--json]
  weles mcp
  weles release surface [--root <directory>]
  weles release enforce-version --decision <file> --baseline <file> --declaration <file> --manifest <file> [--json]
  weles release validate-manifest --manifest <file> --source-revision <sha> --candidate-tag <tag> [--json]
  weles release adopt-baseline --released <version> --published-surface <file> --reason <text> [--correcting <version>] [--json]
  weles figma export-design-assets
  weles figma parse-document <document.json[.gz]> <summary.json> <nodes.json> [<vocabulary.json>]
  weles operator-requests list [--open] [--limit <n>] [--json]
  weles operator-requests show <id> [--json]
  weles operator-requests open --kind <kind> --account <account> --run <run> --instruction <text> [--pid <waiting-process>]
  weles operator-requests close <id> --approved|--unapproved --detail <text>
  weles account-security --login-role <skarbiec-role>
  weles account-security --run <run-id>
  weles app-password --login-role <skarbiec-role>
  weles app-password --run <run-id>
  weles apple-developer-id [--account-role <role>] --confirm "AUTHORIZE ONE APPLE DEVELOPER ID" --execution-host <host> --private-key-out <abs> [--execution-agent <agent>] [--expires-in-minutes <n>] [--subject <dn>]
  weles apple-developer-id --run <run-id> --certificate-out <abs>
  weles apple-login [--account-role <role>] --confirm "AUTHORIZE ONE APPLE LOGIN" --execution-host <host> [--execution-agent <agent>] [--expires-in-minutes <n>] | --run <run-id>
  weles worker <status|start|stop|restart> [--json]
  weles keeper start --session <id> [--url <url>] [--headless]
                          Hold one browser session that answers JSON commands on
                          ~/.weles/keeper/<id>/socket until its page closes
  weles records adopt [--json]  Tag every Weles record in this vault with weles:record:<kind> from its own context
  weles doctor [--json]
  weles version

Options:
  --subject <stable-id>   Stable operator/device scope for durable onboarding progress.
  --receipt <file>        Real terminal Weles service receipt JSON to verify.
  --keys <file>           JSON map of trusted receipt key IDs to PEM public keys.
  --state-dir <dir>       Override the durable onboarding state directory.
  --host <hostname>       Exact managed Weles worker hostname for imported definitions.
  --login-role <role>     The Skarbiec role the Google login plays (the item tagged stado:role:<role>).
                          account-security reads 2FA without signing in; app-password signs in,
                          creates a Google app password and hands it to Skrzynka.
  Worker controls reach the executor at the route 'stado service directory connect weles-admission'
  gives and with the Skarbiec token echo-weles-api#token; WELES_WORKER_API_BASE and
  WELES_WORKER_TOKEN override both.
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
  --open                  List only requests still waiting for the operator.
  --limit <n>             How many operator requests to list (default 20).
  --json                  Print the answer as one JSON document instead of key: value lines.
                          release surface always prints its JSON document: it is the file a release carries.
  --kind <kind>           What kind of action the run needs from the operator.
  --account <account>     The account the operator action belongs to.
  --run <run>             The run that is waiting.
  --instruction <text>    What the operator has to do, in his own terms.
  --pid <process>         The process that waits on the request (default: the caller's parent);
                          a request whose process ended is reported abandoned, never timed out.
  --approved              The operator did the thing this request asked for.
  --unapproved            The wait ended without the operator doing it.
  --detail <text>         One sentence saying how the wait ended.

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
  if (command === 'account-security' || command === 'app-password' || command === 'apple-developer-id' || command === 'apple-login' || command === 'worker' || command === 'records' || command === 'keeper') return command;
  if (command === 'doctor' || command === 'open' || command === 'screenshot' || command === 'mcp' || command === 'onboarding' || command === 'import' || command === 'release' || command === 'figma' || command === 'operator-requests') return command;
  throw new UsageError(`unknown command: ${command}`);
}

function optionTakesValue(key: string): boolean {
  if (key === 'login-item' || key === 'login-role') return true;
  return ['browser', 'os', 'locale', 'chromium-path', 'user-data-dir', 'proxy', 'screenshot', 'wait-for-text', 'subject', 'receipt', 'keys', 'state-dir', 'host', 'decision', 'baseline', 'declaration', 'manifest', 'source-revision', 'candidate-tag', 'released', 'published-surface', 'reason', 'correcting', 'root', 'limit', 'kind', 'account', 'run', 'instruction', 'pid', 'detail', 'account-role', 'confirm', 'execution-host', 'execution-agent', 'private-key-out', 'certificate-out', 'expires-in-minutes', 'private-key', 'store-host', 'session', 'url'].includes(key);
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

async function runOpen(parsed: ParsedCli): Promise<void> {
  const [url] = parsed.positional;
  if (!url) throw new UsageError('open requires <url>');

  routeConsoleToStderr();
  const { AsyncNewBrowser } = await import('./async_api.js');
  const context = await AsyncNewBrowser(cliOptionsToBrowserOptions(parsed.options));
  try {
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (typeof parsed.options['wait-for-text'] === 'string') {
      await page.getByText(parsed.options['wait-for-text'], { exact: false }).first().waitFor({ state: 'visible' });
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
      out.text = await page.locator('body').innerText();
    }

    printAnswer(out, parsed.options.json === true);
  } finally {
    await context.close().catch(() => undefined);
  }
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
  if (parsed.command === 'figma') {
    await runFigma(parsed);
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
  if (parsed.command === 'apple-developer-id') {
    await runAppleDeveloperId(parsed);
    return;
  }
  if (parsed.command === 'apple-login') {
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
