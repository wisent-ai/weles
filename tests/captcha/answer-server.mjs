// The Weles worker's /captcha/answers/ route, served alone for the callback
// journey (provider-callback.mjs). The route module reads the worker's
// configuration, so the journey starts this file with the variables the
// worker's declaration states and a HOME of its own, which puts the answers
// directory under the journey's build directory. Like the worker, it clears
// the answers an earlier server's runs left before it listens. Prints the
// address it listens at and the answers directory as one JSON line, then
// serves until it is killed.

import { createServer } from 'node:http';
import { constants as http } from 'node:http2';
import { once } from 'node:events';

const {
  forgetEveryCaptchaAnswer,
  isCaptchaAnswerRoute,
  respondToCaptchaAnswer,
} = await import(
  '../../src/worker/weles-api-server/routes/captcha/answers.mjs'
);
const { json } = await import(
  '../../src/worker/weles-api-server/http-exchange.mjs'
);
const { CAPTCHA_ANSWERS_DIR } = await import(
  '../../src/worker/weles-api-server/configuration.mjs'
);

forgetEveryCaptchaAnswer();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!isCaptchaAnswerRoute(req, url)) {
    json(res, http.HTTP_STATUS_NOT_FOUND, { ok: false, error: 'not_found' });
    return;
  }
  try {
    await respondToCaptchaAnswer(req, res, url);
  } catch (error) {
    json(res, http.HTTP_STATUS_INTERNAL_SERVER_ERROR, {
      ok: false,
      error: error.message,
    });
  }
});
const listening = once(server, 'listening');
server.listen(); // The operating system assigns the listening port.
await listening;
console.log(
  JSON.stringify({
    origin: `http://localhost:${server.address().port}`,
    answers: CAPTCHA_ANSWERS_DIR,
  }),
);
