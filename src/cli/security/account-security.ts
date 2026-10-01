import type { ParsedCli } from '../../cli.js';
import { accountSecurityRun } from '../../runtime/api/account-security.js';
import { printAnswer } from '../usage.js';

export async function runAccountSecurity(parsed: ParsedCli): Promise<void> {
  if (parsed.positional.length || Object.keys(parsed.options).some((key) => key !== 'login-role' && key !== 'run' && key !== 'json')) {
    throw new Error('account-security accepts --login-role or --run; it cannot enable, disable or enrol 2FA');
  }
  const loginRole = parsed.options['login-role'];
  const runId = parsed.options.run;
  if ((loginRole !== undefined) === (runId !== undefined)
    || (loginRole !== undefined && typeof loginRole !== 'string')
    || (runId !== undefined && typeof runId !== 'string')) {
    throw new Error('provide exactly one of --login-role <skarbiec-role> or --run <run-id>');
  }
  const row = await accountSecurityRun(typeof loginRole === 'string' ? { loginRole } : { runId: runId as string });
  printAnswer(row, parsed.options.json === true);
  if (row.result?.ok === false || row.error || (row.completed_at && !row.result)) process.exitCode = 1;
}
