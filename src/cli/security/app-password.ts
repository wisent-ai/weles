import type { ParsedCli } from '../../cli.js';
import { appPasswordRun } from '../../runtime/api/app-password.js';
import { printAnswer, UsageError } from '../usage.js';

export async function runAppPassword(parsed: ParsedCli): Promise<void> {
  if (parsed.positional.length || Object.keys(parsed.options).some((key) => key !== 'login-role' && key !== 'login-item' && key !== 'run' && key !== 'json')) {
    throw new UsageError('app-password accepts --login-role, --login-item or --run, and --json');
  }
  const loginRole = parsed.options['login-role'];
  const loginItem = parsed.options['login-item'];
  const runId = parsed.options.run;
  if (Number(loginRole !== undefined) + Number(loginItem !== undefined) + Number(runId !== undefined) !== 1
    || (loginRole !== undefined && (typeof loginRole !== 'string' || !loginRole.trim()))
    || (loginItem !== undefined && (typeof loginItem !== 'string' || !loginItem.trim()))
    || (runId !== undefined && (typeof runId !== 'string' || !runId.trim()))) {
    throw new UsageError('provide exactly one of --login-role <skarbiec-role>, --login-item <skarbiec-item> or --run <run-id>');
  }
  const input = typeof loginRole === 'string' ? { loginRole }
    : typeof loginItem === 'string' ? { loginItem } : { runId: runId as string };
  const row = await appPasswordRun(input);
  printAnswer(row, parsed.options.json === true);
  if (row.ok === false || row.error) process.exitCode = 1;
}
