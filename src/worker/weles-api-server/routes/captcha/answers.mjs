// POST /captcha/answers/<run>/<token>: the answer a captcha provider pushes
// for a task a run of this server created.
//
// The providers call back without a Weles bearer, so the route is admitted by
// what only the run and the provider know: the token in the address, which the
// run drew at random for that one task and registered as waiting
// (<token>.waiting in the run's own directory under CAPTCHA_ANSWERS_DIR,
// src/captcha/providers/callback.ts). The run's directory is removed when the
// run's registration ends (run/running-runs.mjs), however it ended, and the
// whole answers root when the server starts, since no run of a new server
// waits yet; so a token whose run is gone is answered 404 like one no run
// ever drew, before its body is read, and so is one whose run ends while its
// answer is being written. The body is kept as sent, with its content type
// (null when the request states none): AntiCaptcha, CapMonster and CapSolver
// POST the getTaskResult answer as JSON, 2captcha its id and code as a form,
// and the run reads its own provider's form. Only the first callback of a
// token is kept: it claims the marker by renaming it, which one request alone
// can do, so a repeat, before or after the run read the answer, is answered
// 404 and leaves nothing behind. The answer is written under a temporary name
// and renamed into place, so the run that watches the directory never reads
// half an answer.

import { constants as http } from 'node:http2';
import { rmSync } from 'node:fs';
import { access, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { CAPTCHA_ANSWERS_DIR } from '../../configuration.mjs';
import { json, readText } from '../../http-exchange.mjs';

export const CAPTCHA_ANSWER_PATH = '/captcha/answers/';

/** Whether `segment` is one plain path segment, never a way out of its directory. */
function plain(segment) {
  return Boolean(segment) && basename(segment) === segment && !segment.startsWith('.');
}

/** The directory the answers of run `runId` are written to and waited for in. */
export function captchaAnswersOf(runId) {
  if (!plain(runId)) throw new Error(`run id ${runId} cannot name a captcha answers directory`);
  return join(CAPTCHA_ANSWERS_DIR, runId);
}

/** Removes run `runId`'s captcha answers directory and everything a provider left in it. */
export function forgetCaptchaAnswers(runId) {
  rmSync(captchaAnswersOf(runId), { recursive: true, force: true });
}

/** Removes every run's captcha answers: what an earlier server's runs left. */
export function forgetEveryCaptchaAnswer() {
  rmSync(CAPTCHA_ANSWERS_DIR, { recursive: true, force: true });
}

/** The run and token a POST to the answers route names, or null for any other request. */
function answerAddress(req, url) {
  if (req.method !== 'POST' || !url.pathname.startsWith(CAPTCHA_ANSWER_PATH))
    return null;
  const [run, token, ...rest] = url.pathname.slice(CAPTCHA_ANSWER_PATH.length).split('/');
  if (rest.length || !plain(run) || !plain(token)) return null;
  return { directory: captchaAnswersOf(run), token };
}

export function isCaptchaAnswerRoute(req, url) {
  return answerAddress(req, url) !== null;
}

function nobodyWaits(res) {
  json(res, http.HTTP_STATUS_NOT_FOUND, {
    ok: false,
    error: 'no_run_waits_for_this_answer',
  });
}

export async function respondToCaptchaAnswer(req, res, url) {
  const { directory, token } = answerAddress(req, url);
  const waiting = join(directory, `${token}.waiting`);
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
  const claimed = join(directory, `.${token}.claimed`);
  try {
    await rename(waiting, claimed);
    const partial = join(directory, `.${token}.json.part`);
    await writeFile(partial, JSON.stringify(answer));
    await rename(partial, join(directory, `${token}.json`));
    await rm(claimed);
  } catch (error) {
    // The marker taken by another callback, or the run's directory removed
    // because the run ended: no run waits for this answer.
    if (error.code !== 'ENOENT') throw error;
    nobodyWaits(res);
    return;
  }
  json(res, http.HTTP_STATUS_OK, { ok: true });
}
