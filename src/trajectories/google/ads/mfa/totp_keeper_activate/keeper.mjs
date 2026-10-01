// The keeper session behind the activation: its socket and its actions. This
// module talks to a running keeper; it never starts one.
import { keeperRequest } from '../../../../_shared/keeper/client.mjs';
import { SOCK } from './settings.mjs';

export async function action(cmd) {
  const answer = await keeperRequest(SOCK, cmd);
  if (!answer.ok) throw new Error(answer.error || `keeper action failed: ${cmd.action}`);
  return answer;
}

// The activation needs a keeper that is already running. Asking it for its
// URL once is the check; a missing or silent keeper is reported with the
// socket error that says which.
export async function requireKeeper() {
  await action({ action: 'url' });
}
