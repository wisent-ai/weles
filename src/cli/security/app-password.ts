import type { ParsedCli } from '../../cli.js';
import { appPasswordRun } from '../../runtime/api/app-password.js';

export async function runAppPassword(parsed: ParsedCli): Promise<void> {
  if (parsed.positional.length || Object.keys(parsed.options).some((key) => key !== 'login-role' && key !== 'run')) {
    throw new Error('app-password accepts --login-role or --run');
  }
  const loginRole = parsed.options['login-role'];
  const runId = parsed.options.run;
  if ((loginRole !== undefined) === (runId !== undefined)
    || (loginRole !== undefined && typeof loginRole !== 'string')
    || (runId !== undefined && typeof runId !== 'string')) {
    throw new Error('provide exactly one of --login-role <skarbiec-role> or --run <run-id>');
  }
  const row = await appPasswordRun(typeof loginRole === 'string' ? { loginRole } : { runId: runId as string });
  process.stdout.write(`${JSON.stringify(row)}\n`);
  if (row.ok === false || row.error) process.exitCode = 1;
}
