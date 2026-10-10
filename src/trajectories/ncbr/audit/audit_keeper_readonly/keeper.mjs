// The keeper transport: one command per socket connection, and the navigation, evaluation
// and screenshot commands the audit is built from.
import { keeperRequest } from '../../../_shared/keeper/client.mjs';
import { SOCK } from './settings.mjs';

export async function send(cmd) {
  const res = await keeperRequest(SOCK, cmd);
  if (!res.ok) throw new Error(`${cmd.action} failed: ${res.error}`);
  return res;
}

export async function nav(url) {
  const out = await send({ action: 'nav', url });
  await send({ action: 'settle' });
  return out;
}

export async function read(js) {
  return (await send({ action: 'eval', js })).result;
}

export async function shot(label) {
  const s = await send({ action: 'screenshot' });
  return { label, path: s.path };
}
