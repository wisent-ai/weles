// LinkedIn's checkpoints, and the captcha LinkedIn's login asks for.
import { CaptchaSolver } from '../../../../dist/captcha/solver.js';
import { solveRecaptchaV2 as solveRecaptchaV2InPage } from '../../../../dist/captcha/recaptcha.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { humanType } from '../../../../dist/human/keyboard.js';
import { pageSettled, urlMatching } from '../page/settled.mjs';
import {
  inboxConfigured,
  messagesTo,
} from '../../../_shared/mail/skrzynka-inbox.mjs';
import { onCheckpointRoute } from './sign_in.mjs';

// The site key of the reCAPTCHA Enterprise LinkedIn's login form runs.
const RECAPTCHA_SITEKEY = '6LcIy_MqAAAAAMKiupFSbmzW3xjGSlIfRzNWYMjC';
// The page key of LinkedIn's email-PIN checkpoint.
const EMAIL_PIN_PAGE = 'emailPinChallenge';

const liAtOf = async (ctx) =>
  (await ctx.cookies()).find((c) => c.name === 'li_at' && c.value);

/**
 * The PIN fields of LinkedIn's email-PIN checkpoint: one field that takes
 * the whole PIN (`single`), or one box per digit (`boxes`); with the PIN
 * length each declares (the field's maxlength, the number of boxes).
 */
async function pinFields(page) {
  const single = page
    .locator(
      'input[name="pin"], input[autocomplete="one-time-code"], input[name*="pin" i]',
    )
    .filter({ visible: true })
    .first();
  if (await single.count()) {
    const length = Number(await single.getAttribute('maxlength'));
    return {
      single,
      length: Number.isSafeInteger(length) && length ? length : undefined,
    };
  }
  const boxes = await page
    .locator('input[name^="pin-"], input[name^="otp-"]')
    .filter({ visible: true })
    .all();
  return { boxes, length: boxes.length };
}

/**
 * LinkedIn's email-PIN checkpoint, which it shows a known account signing in
 * from a new device or address: the PIN LinkedIn mailed for this checkpoint
 * (a mail that arrived after the checkpoint opened), typed into its fields.
 * Answers false when the page is another checkpoint; throws when the PIN or
 * its fields are missing.
 */
async function solveEmailPinChallenge(page, email) {
  const pageKeyMeta = page.locator('meta[name="pageKey"]').first();
  if (!(await pageKeyMeta.count())) return false;
  if (!(await pageKeyMeta.getAttribute('content'))?.includes(EMAIL_PIN_PAGE))
    return false;
  if (!inboxConfigured())
    throw new Error(
      `LINKEDIN_PIN_UNREADABLE: the email-PIN checkpoint needs the mail to ${email}, and no Skrzynka organization is configured`,
    );
  const opened = Date.now();
  const { single, boxes, length } = await pinFields(page);
  if (!length)
    throw new Error(
      `LINKEDIN_PIN_FIELDS_MISSING: ${page.url()} shows no PIN field that states its length`,
    );
  const pin = new RegExp(`\\b\\d{${length}}\\b`);
  const mailed = (await messagesTo(email, 'linkedin.com'))
    .filter((m) => Date.parse(m.received_at) >= opened)
    .map((m) => `${m.subject}\n${m.body_text}`.match(pin)?.shift())
    .find(Boolean);
  if (!mailed)
    throw new Error(
      `LINKEDIN_PIN_NOT_RECEIVED: no ${length}-digit PIN to ${email} has arrived since the checkpoint opened; run the login again once it is in the inbox`,
    );
  if (single) {
    await humanClickLocator(page, single);
    await humanType(page, mailed);
  } else {
    for (const [index, digit] of [...mailed].entries()) {
      await humanClickLocator(page, boxes[index]);
      await humanType(page, digit);
    }
  }
  await humanClickLocator(
    page,
    page
      .locator('button[type="submit"], button#email-pin-submit-button')
      .filter({ visible: true })
      .first(),
  );
  await pageSettled(page);
  return true;
}

/**
 * Solve the checkpoint the page shows: the email PIN when it is that one;
 * the NopeCha extension's in-page solve when WELES_NOPECHA_EXT=1 (leaving
 * the checkpoint is its answer); otherwise the in-page image-grid solver,
 * once (a second grid on the same flagged session only trips LinkedIn's
 * login restriction). Answers the li_at cookie, if one was set, and where
 * the page ended.
 */
export async function solveLinkedinCheckpoint({ ctx, page }, reason, email) {
  let liAt = await liAtOf(ctx);
  if (liAt || !onCheckpointRoute(page.url()))
    return { liAt, finalUrl: page.url() };
  if (email && (await solveEmailPinChallenge(page, email))) {
    liAt = await liAtOf(ctx);
    if (liAt || !onCheckpointRoute(page.url()))
      return { liAt, finalUrl: page.url() };
  }
  if (process.env.WELES_NOPECHA_EXT === '1') {
    console.log(
      `[linkedin_login] ${reason}: the NopeCha extension solves the checkpoint in the page`,
    );
    await urlMatching(page, (url) => !onCheckpointRoute(url));
    return { liAt: await liAtOf(ctx), finalUrl: page.url() };
  }
  // The checkpoint serves the visible V2 Enterprise image grid: a token put
  // into the outer page does not trigger its verify callback, so the grid is
  // solved inside its own frame.
  console.log(
    `[linkedin_login] ${reason}: solving the checkpoint's image grid`,
  );
  const solved = await solveRecaptchaV2InPage(page);
  await pageSettled(page);
  liAt = await liAtOf(ctx);
  if (!liAt && onCheckpointRoute(page.url()))
    console.log(
      `[linkedin_login] linkedin_checkpoint_unsolved: solver=${solved} url=${page.url()}`,
    );
  return { liAt, finalUrl: page.url() };
}

/**
 * Confirm the account's email from the confirmation link LinkedIn mailed
 * (https://www.linkedin.com/comm/psettings/email/confirm?...), opened on the
 * signed-in session: until then LinkedIn keeps its banner on the feed and
 * limits the account. Answers whether the link was found and opened.
 */
export async function confirmLinkedinEmail(page, email) {
  if (!inboxConfigured())
    return {
      ok: false,
      reason:
        'no Skrzynka organization is configured to read the confirmation mail',
    };
  const link = (await messagesTo(email, 'linkedin.com'))
    .map((m) =>
      m.body_text
        .match(
          /https:\/\/www\.linkedin\.com\/comm\/psettings\/email\/confirm\?[^\s<>"]+/,
        )
        ?.shift(),
    )
    .find(Boolean);
  if (!link)
    return {
      ok: false,
      reason: `no confirmation link in the mail to ${email}`,
    };
  await page.goto(link, { waitUntil: 'domcontentloaded' });
  await pageSettled(page);
  return { ok: true, finalUrl: page.url() };
}

/**
 * Solve the invisible reCAPTCHA Enterprise V3 LinkedIn's login runs on
 * submit and put the token where the page reads it: a flagged session's own
 * token scores low and sends the login to a checkpoint. A solver that
 * answers no token throws.
 */
export async function injectV3LoginToken(page) {
  let token;
  try {
    token = await new CaptchaSolver().solveRecaptchaV3(
      RECAPTCHA_SITEKEY,
      page.url(),
      'login',
    );
  } catch (error) {
    throw new Error(`LINKEDIN_LOGIN_TOKEN_UNSOLVED: ${error.message}`, { cause: error });
  }
  await page.evaluate((solvedToken) => {
    for (const recaptcha of [
      window.grecaptcha?.enterprise,
      window.grecaptcha,
    ].filter(Boolean)) {
      recaptcha.execute = () => Promise.resolve(solvedToken);
      recaptcha.getResponse = () => solvedToken;
    }
    for (const field of document.querySelectorAll(
      'textarea[name^="g-recaptcha-response"]',
    ))
      field.value = solvedToken;
  }, token);
}
