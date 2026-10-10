// JSON command frontend for the persistent socket keeper, not Tencent CDP.
// SESSION selects the existing keeper; stdin carries its structured command.
// No browser is launched and secret-bearing arguments never enter argv.
import { keeperRequest, keeperSocket } from './client.mjs';
import { UsageError, exitStatusFor } from '../../../../dist/cli/usage.js';

try {
  const session = process.env.SESSION;
  if (!session) throw new UsageError('keeper action needs SESSION');
  process.stdin.setEncoding('utf8');
  let body = '';
  for await (const chunk of process.stdin) body += chunk;
  const command = JSON.parse(body);
  if (!command || typeof command !== 'object' || Array.isArray(command))
    throw new UsageError('keeper action needs a JSON object on stdin');
  const answer = await keeperRequest(keeperSocket(session), command);
  console.log(JSON.stringify(answer));
  if (!answer.ok) process.exitCode = exitStatusFor(new Error(answer.error));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = exitStatusFor(error);
}
