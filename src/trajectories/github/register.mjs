// GitHub signup. A fresh identity fills github.com/signup; GitHub's Arkose
// puzzle is solved by the Stado model router reading the puzzle frame
// (captcha/coords_solver.mjs) and, when WELES_EXTERNAL_FUNCAPTCHA=1 and that
// did not get past it, by the shared captcha services with the public key the
// puzzle itself requested; the email code GitHub sends is read from Skrzynka.
// A puzzle GitHub keeps serving saves the identity as captcha_blocked and
// fails the run with GITHUB_SIGNUP_CAPTCHA_BLOCKED; nothing is retried here.
// Waits have no deadline: the browser context sets none.
import { WSession } from '../../../dist/session/wsession.js';
import { CaptchaSolver } from '../../../dist/captcha/solver.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { exitStatusFor } from '../../../dist/cli/usage.js';
import { clickDescribed } from '../_shared/page/judged/seen.mjs';
import { pageSettled } from '../_shared/page/settled.mjs';
import { statedProxy } from '../_shared/inputs/stated.mjs';
import { autoBindCharacter } from '../lib/character-bind.mjs';
import { messagesTo } from '../../_shared/mail/skrzynka-inbox.mjs';
import {
  PUZZLE_FRAME,
  solveRotationViaCoords,
} from './captcha/coords_solver.mjs';

const SIGNUP_URL = 'https://github.com/signup';
const ALERT = '.flash-error, [role="alert"]';
const CODE_FIELD =
  'input[autocomplete="one-time-code"], input[name*="code"], input[inputmode="numeric"]';

/** The Arkose public key, its API host and the blob, as the puzzle frame requests them. */
function watchArkose(ctx) {
  const seen = {};
  ctx.on('request', (req) => {
    const url = new URL(req.url());
    if (!url.hostname.endsWith('arkoselabs.com')) return;
    const key = `${url.pathname}${url.search}`.match(
      /public_key[/=](?<key>[\dA-F-]+)/i,
    );
    if (key)
      Object.assign(seen, {
        publicKey: key.groups.key,
        subdomain: url.hostname,
      });
    const body = req.postData();
    const blob = body && new URLSearchParams(body).get('data[blob]');
    if (blob) seen.blob = blob;
  });
  return seen;
}

/** Types `value` into the field and refuses a field that does not then hold it. */
async function fillField(page, selector, value) {
  const field = page.locator(selector).first();
  const editable = field.and(page.locator('input:enabled:not([readonly])'));
  await editable.waitFor({ state: 'visible' });
  await humanClickLocator(page, editable);
  await humanType(page, value);
  const actual = await field.inputValue();
  if (actual !== value)
    throw new Error(
      `GITHUB_SIGNUP_FIELD_MISMATCH: ${selector} holds ${actual.length} characters after typing ${value.length}`,
    );
  await page.keyboard.press('Tab');
}

/** Waits until the page leaves `from` or shows GitHub's alert; true when it left. */
async function leftOrRefused(page, from) {
  await Promise.race([
    page.waitForURL((url) => url.href !== from),
    page.locator(ALERT).first().waitFor({ state: 'visible' }),
  ]);
  return page.url() !== from;
}

/** The puzzle answered by the shared captcha services, its token submitted with GitHub's form. */
async function solveWithServices(page, arkose, from) {
  if (!arkose.publicKey)
    throw new Error(
      'GITHUB_ARKOSE_KEY_UNSEEN: the puzzle frame made no request naming its public key, so no captcha service can be asked',
    );
  const token = await new CaptchaSolver().solveFuncaptcha(
    arkose.publicKey,
    SIGNUP_URL,
    arkose.subdomain,
    arkose.blob,
  );
  const form = page
    .locator('form.js-octocaptcha-parent, form[data-octo-click-hmac]')
    .first();
  if (!(await form.count()))
    throw new Error(
      `GITHUB_CAPTCHA_FORM_MISSING: ${page.url()} shows no octocaptcha form for the token`,
    );
  await form.evaluate((f, tk) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    ).set;
    for (const input of f.querySelectorAll(
      'input[name="octocaptcha-token"], input.js-octocaptcha-token',
    )) {
      setter.call(input, tk);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    f.requestSubmit();
  }, token);
  return leftOrRefused(page, from);
}

/** The code GitHub mailed since `seenBefore`, as long as the code field takes; the inbox is read until it holds one. */
async function mailedCode(email, seenBefore, length) {
  const pin = new RegExp(`\\b\\d{${length}}\\b`);
  for (;;) {
    const code = (await messagesTo(email, 'github.com'))
      .filter((mail) => !seenBefore.has(mail.id))
      .map((mail) => mail.body_text.match(pin)?.shift())
      .find(Boolean);
    if (code) return code;
  }
}

const s = await WSession.start({
  label: 'github_register',
  proxy: statedProxy('the GitHub signup'),
  locale: 'en-US',
});
try {
  const id = await s.generateIdentity('github');
  const email = s.resolveEnv('$GITHUB_NEW_EMAIL');
  console.log(`[register] identity: username=${id.username} email=${email}`);
  const arkose = watchArkose(s.ctx);
  await s.goto('https://github.com/');
  await pageSettled(s.page);
  await s.goto(SIGNUP_URL);
  await fillField(s.page, '#email', email);
  await fillField(s.page, '#password', s.resolveEnv('$GITHUB_NEW_PASSWORD'));
  await fillField(s.page, '#login', s.resolveEnv('$GITHUB_NEW_USERNAME'));
  // GitHub's validators mark each field when it passes.
  await s.page.waitForFunction(
    `['#email', '#password', '#login'].every((field) => document.querySelector(field).classList.contains('is-autocheck-successful'))`,
  );
  const seenBefore = new Set(
    (await messagesTo(email, 'github.com')).map((mail) => mail.id),
  );
  const create = s.page.locator('button.js-octocaptcha-load-captcha').first();
  if (await create.isVisible()) await humanClickLocator(s.page, create);
  else
    await clickDescribed(
      s.page,
      'the button that creates the account from the filled form (not a sign-up through another provider)',
    );

  // GitHub may leave the puzzle frame unloaded (its address in data-src), and
  // its frame loads the widget once acknowledged (require_ack); the message
  // shapes its versions have taken are each posted.
  const frame = s.page.locator(PUZZLE_FRAME).first();
  await frame.waitFor({ state: 'attached' });
  await frame.evaluate((f) => {
    const pending = f.getAttribute('data-src');
    if (pending && !f.getAttribute('src')) f.setAttribute('src', pending);
    for (const message of [
      { type: 'ack', acked: true },
      'ack',
      { event: 'ack' },
      { type: 'octocaptcha:ack' },
    ])
      f.contentWindow.postMessage(message, '*');
  });
  const captchaUrl = s.page.url();
  let solved = await solveRotationViaCoords(s.page, {
    advanced: async () => s.page.url() !== captchaUrl,
    refused: () => s.page.locator(ALERT).first().isVisible(),
  });
  if (!solved && process.env.WELES_EXTERNAL_FUNCAPTCHA === '1')
    solved = await solveWithServices(s.page, arkose, captchaUrl);
  if (!solved) {
    await s.saveAccount('github', {
      username: id.username,
      email,
      password: id.password,
      status: 'captcha_blocked',
    });
    throw new Error(
      `GITHUB_SIGNUP_CAPTCHA_BLOCKED: GitHub kept ${id.username} at its puzzle on ${s.page.url()}; saved as captcha_blocked`,
    );
  }

  const codeField = s.page.locator(CODE_FIELD).filter({ visible: true });
  await codeField.first().waitFor({ state: 'visible' });
  const boxes = await codeField.count();
  const length =
    boxes === Math.sign(boxes)
      ? Number(await codeField.first().getAttribute('maxlength'))
      : boxes;
  if (!Number.isSafeInteger(length) || !length)
    throw new Error(
      `GITHUB_SIGNUP_CODE_LENGTH_UNKNOWN: the code field on ${s.page.url()} states no maxlength`,
    );
  const code = await mailedCode(email, seenBefore, length);
  const codeUrl = s.page.url();
  await humanClickLocator(s.page, codeField.first());
  await humanType(s.page, code);
  const verified = await leftOrRefused(s.page, codeUrl);
  await s.saveAccount('github', {
    username: id.username,
    email,
    password: id.password,
    status: verified ? 'verified' : 'needs_verification',
  });
  if (!verified)
    throw new Error(
      `GITHUB_SIGNUP_CODE_REFUSED: GitHub stayed on ${codeUrl} after the mailed code; saved as needs_verification`,
    );
  console.log(
    `[bind] ${JSON.stringify(await autoBindCharacter(id.username, 'github'))}`,
  );
  console.log(`PASS: ${id.username} (verified)`);
} catch (error) {
  console.error('FAIL:', error);
  process.exitCode = exitStatusFor(error);
} finally {
  await s.close();
}
