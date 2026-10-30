#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDoctor } from './cli/diagnostics.js';
import { runOpen } from './cli/entry/open.js';
import { parseCliArgs } from './cli/entry/parse.js';
import {
  runImport,
  runOnboarding,
  runRelease,
  runDesign,
} from './cli/workflows.js';
import { runRuns } from './cli/worker/runs.js';
import { runAccountSecurity } from './cli/security/account-security.js';
import { runAppPassword } from './cli/security/app-password.js';
import { runAppleDeveloperId } from './cli/security/apple-developer-id.js';
import { runAppleLogin } from './cli/security/apple-login.js';
import { runRecordingsScrub } from './cli/security/recordings-scrub.js';
import { runWorker } from './cli/worker/index.js';
import { runKeeper } from './cli/keeper.js';
import { runPointer } from './cli/pointer.js';
import { adoptRecords } from './state/skarbiec-records.js';
import { DeclaredError } from './errors/index.cjs';
import { runErrors } from './cli/errors.js';
import { HELP, UsageError, exitStatusFor, printAnswer } from './cli/usage.js';

export type CliCommand =
  | 'help'
  | 'version'
  | 'doctor'
  | 'open'
  | 'mcp'
  | 'onboarding'
  | 'import'
  | 'release'
  | 'design'
  | 'runs'
  | 'security'
  | 'password'
  | 'certificate'
  | 'login'
  | 'worker'
  | 'records'
  | 'recordings'
  | 'keeper'
  | 'pointer'
  | 'errors';

export type ParsedCli = {
  command: CliCommand;
  positional: string[];
  options: Record<string, string | boolean>;
};

const PACKAGE_MANIFEST = join(__dirname, '..', 'package.json');

// The installed package's own manifest. One that cannot be read or parsed is
// refused with its path: read as {}, `weles version` printed "unknown" and
// doctor checked an install it could not identify.
function readPackageJson(): { version?: string; bin?: unknown } {
  try {
    return JSON.parse(readFileSync(PACKAGE_MANIFEST, 'utf8')) as {
      version?: string;
      bin?: unknown;
    };
  } catch (error) {
    throw new Error(
      `Weles package manifest ${PACKAGE_MANIFEST} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function usage(): string {
  return HELP;
}

/** `--help` or `-h` after a command: that command's usage lines from HELP. */
function commandUsage(command: CliCommand): string {
  const prefix = `  weles ${command}`;
  const lines = HELP.split('\n').filter(
    (line) => line === prefix || line.startsWith(`${prefix} `),
  );
  return lines.length ? `Usage:\n${lines.join('\n')}\n` : HELP;
}

async function runVersion(): Promise<void> {
  const { version } = readPackageJson();
  if (typeof version !== 'string' || !version)
    throw new Error(
      `the Weles package manifest ${PACKAGE_MANIFEST} names no version`,
    );
  process.stdout.write(`${version}\n`);
}

async function runRecords(parsed: ParsedCli): Promise<void> {
  const action = parsed.positional.join(' ');
  if (action !== 'adopt')
    throw new UsageError(`weles records takes adopt, not ${action}`);
  if (Object.keys(parsed.options).some((key) => key !== 'json'))
    throw new UsageError('records adopt takes only --json');
  printAnswer(adoptRecords(), parsed.options.json === true);
}

async function runMcp(): Promise<void> {
  const { startMcpServer } = await import('./mcp.js');
  startMcpServer();
}

/** What each command runs. */
const COMMAND_RUNS: Readonly<
  Record<CliCommand, (parsed: ParsedCli) => Promise<void>>
> = Object.freeze({
  help: async () => {
    process.stdout.write(HELP);
  },
  version: runVersion,
  doctor: (parsed: ParsedCli) =>
    runDoctor(readPackageJson(), parsed.options.json === true),
  open: runOpen,
  mcp: runMcp,
  onboarding: runOnboarding,
  import: runImport,
  release: runRelease,
  design: runDesign,
  runs: runRuns,
  security: runAccountSecurity,
  password: runAppPassword,
  certificate: runAppleDeveloperId,
  login: runAppleLogin,
  worker: runWorker,
  records: runRecords,
  recordings: runRecordingsScrub,
  keeper: runKeeper,
  pointer: runPointer,
  errors: runErrors,
});

/** The arguments after the interpreter and this script. */
function commandLine(): string[] {
  const [, , ...argv] = process.argv;
  return argv;
}

export async function runCli(argv = commandLine()): Promise<void> {
  const parsed = parseCliArgs(argv);
  // `--help` or `-h` after a command answers with that command's usage lines
  // and never runs it: `weles open --help` used to fail with "open requires
  // <url>".
  if (
    parsed.command !== 'help' &&
    (parsed.options.help === true || parsed.positional.includes('-h'))
  ) {
    process.stdout.write(commandUsage(parsed.command));
    return;
  }
  await COMMAND_RUNS[parsed.command](parsed);
}

/**
 * How a failure is reported: `weles: <what failed, why, observed>` on standard
 * error, and for a declared cause the fix and the cause's id under it; with
 * --json the declared cause's answer is also printed as one JSON document on
 * standard output.
 */
function reportFailure(error: unknown, argv: string[]): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`weles: ${message}\n`);
  if (error instanceof DeclaredError) {
    process.stderr.write(`${error.explanation()}\n`);
    if (argv.includes('--json'))
      process.stdout.write(`${JSON.stringify(error.answer(), null, 2)}\n`);
  }
  process.exitCode = exitStatusFor(error);
}

if (require.main === module) {
  const argv = commandLine();
  runCli(argv).catch((error: unknown) => reportFailure(error, argv));
}
