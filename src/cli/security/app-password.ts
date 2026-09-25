import type { ParsedCli } from '../../cli.js';
import { appPasswordRun } from '../../runtime/api/app-password.js';

export async function runAppPassword(parsed: ParsedCli): Promise<void> {
  if (parsed.positional.length || Object.keys(parsed.options).some((key) => key !== 'login-item' && key !== 'run')) {
    throw new Error('app-password accepts --login-item or --run');
  }
  const loginItem = parsed.options['login-item'];
  const runId = parsed.options.run;
  if ((loginItem !== undefined) === (runId !== undefined)
    || (loginItem !== undefined && typeof loginItem !== 'string')
    || (runId !== undefined && typeof runId !== 'string')) {
    throw new Error('provide exactly one of --login-item <skarbiec-item> or --run <run-id>');
  }
  const row = await appPasswordRun(typeof loginItem === 'string' ? { loginItem } : { runId: runId as string });
  process.stdout.write(`${JSON.stringify(row)}\n`);
  if (row.ok === false || row.error) process.exitCode = 1;
}
