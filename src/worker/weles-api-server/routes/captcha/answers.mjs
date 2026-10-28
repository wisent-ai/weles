// POST /captcha/answers/<token>: the answer a captcha provider pushes for a
// task a run of this server created.
//
// The providers call back without a Weles bearer, so the route is admitted by
// what only the run and the provider know: the token in the address, which the
// run drew at random for that one task and registered as waiting
// (<token>.waiting in CAPTCHA_ANSWERS_DIR, src/captcha/providers/callback.ts).
// A token no run waits for is answered 404 before its body is read. The body
// is kept as sent, with its content type (null when the request states none):
// AntiCaptcha, CapMonster and CapSolver POST the getTaskResult answer as JSON,
// 2captcha its id and code as a form, and the run reads its own provider's
// form. Only the first callback of a token is kept: it claims the marker by
// renaming it, which one request alone can do, so a repeat, before or after
// the run read the answer, is answered 404 and leaves nothing behind. The
// answer is written under a temporary name and renamed into place, so the
// run that watches the directory never reads half an answer.

import { constants as http } from 'node:http2';
import { access, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { CAPTCHA_ANSWERS_DIR } from '../../configuration.mjs';
import { json, readText } from '../../http-exchange.mjs';

export const CAPTCHA_ANSWER_PATH = '/captcha/answers/';

/** The token a POST to the answers route names, or null for any other request. */
function answerToken(req, url) {
  if (req.method !== 'POST' || !url.pathname.startsWith(CAPTCHA_ANSWER_PATH))
    return null;
  const token = url.pathname.slice(CAPTCHA_ANSWER_PATH.length);
  if (!token || basename(token) !== token || token.startsWith('.')) return null;
  return token;
}

export function isCaptchaAnswerRoute(req, url) {
  return answerToken(req, url) !== null;
}

function nobodyWaits(res) {
  json(res, http.HTTP_STATUS_NOT_FOUND, {
    ok: false,
    error: 'no_run_waits_for_this_answer',
  });
}

export async function respondToCaptchaAnswer(req, res, url) {
  const token = answerToken(req, url);
  const waiting = join(CAPTCHA_ANSWERS_DIR, `${token}.waiting`);
  try {
    await access(waiting);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    nobodyWaits(res);
    return;
  }
  const stated = req.headers['content-type'];
  const answer = {
    contentType: stated === undefined ? null : stated,
    body: await readText(req),
  };
  const claimed = join(CAPTCHA_ANSWERS_DIR, `.${token}.claimed`);
  try {
    await rename(waiting, claimed);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    nobodyWaits(res);
    return;
  }
  const partial = join(CAPTCHA_ANSWERS_DIR, `.${token}.json.part`);
  await writeFile(partial, JSON.stringify(answer));
  await rename(partial, join(CAPTCHA_ANSWERS_DIR, `${token}.json`));
  await rm(claimed);
  json(res, http.HTTP_STATUS_OK, { ok: true });
}
