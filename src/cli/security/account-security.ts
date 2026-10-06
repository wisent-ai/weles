import type { ParsedCli } from '../../cli.js';
import { accountSecurityRun } from '../../runtime/api/account-security.js';
import { printAnswer, UsageError } from '../usage.js';

// The identity provider whose account security is read is an argument, and
// google is the one implemented. Reading a run back needs only its id.
const PROVIDER = 'google';

export async function runAccountSecurity(parsed: ParsedCli): Promise<void> {
  if (parsed.positional.length || Object.keys(parsed.options).some((key) => key !== 'provider' && key !== 'login-role' && key !== 'run' && key !== 'json')) {
    throw new UsageError('account-security accepts --provider with --login-role, or --run; it cannot enable, disable or enrol 2FA');
  }
  const loginRole = parsed.options['login-role'];
  const runId = parsed.options.run;
  if ((loginRole !== undefined) === (runId !== undefined)
    || (loginRole !== undefined && typeof loginRole !== 'string')
    || (runId !== undefined && typeof runId !== 'string')) {
    throw new UsageError('provide exactly one of --login-role <skarbiec-role> or --run <run-id>');
  }
  if (runId !== undefined && parsed.options.provider !== undefined) {
    throw new UsageError('--run reads a started run back and takes no --provider');
  }
  if (runId === undefined && parsed.options.provider !== PROVIDER) {
    throw new UsageError(`account-security needs --provider naming the identity provider whose account it reads; Weles reads ${PROVIDER}`);
  }
  const row = await accountSecurityRun(typeof loginRole === 'string' ? { loginRole } : { runId: runId as string });
  printAnswer(row, parsed.options.json === true);
  if (row.result?.ok === false || row.error || (row.completed_at && !row.result)) process.exitCode = 1;
}
