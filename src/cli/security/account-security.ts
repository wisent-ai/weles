import type { ParsedCli } from '../../cli.js';
import { accountSecurityRun } from '../../runtime/api/account-security.js';

export async function runAccountSecurity(parsed: ParsedCli): Promise<void> {
  if (parsed.positional.length || Object.keys(parsed.options).some((key) => key !== 'login-item' && key !== 'run')) {
    throw new Error('account-security accepts --login-item or --run; it cannot enable, disable or enrol 2FA');
  }
  const loginItem = parsed.options['login-item'];
  const runId = parsed.options.run;
  if ((loginItem !== undefined) === (runId !== undefined)
    || (loginItem !== undefined && typeof loginItem !== 'string')
    || (runId !== undefined && typeof runId !== 'string')) {
    throw new Error('provide exactly one of --login-item <skarbiec-item> or --run <run-id>');
  }
  const row = await accountSecurityRun(typeof loginItem === 'string' ? { loginItem } : { runId: runId as string });
  process.stdout.write(`${JSON.stringify(row)}\n`);
  if (row.result?.ok === false || row.error || (row.completed_at && !row.result)) process.exitCode = 1;
}
