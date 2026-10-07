import { WSession } from '../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { autoBindCharacter } from '../lib/character-bind.mjs';
import { pageSettled } from '../_shared/page/settled.mjs';
import {
  autocompleteField,
  clickFirst,
  control,
  field,
  frameFrom,
} from '../_shared/page/offers.mjs';

const URL = 'https://x.com/i/flow/signup?lang=en';
const HOME = 'https://x.com/home';
const proxy = process.env.PROXY_URL || 'none';

// Twitter's flow marks its own controls with test ids: the signup form's Next,
// the submit, and on every onboarding step a Skip control and a Next control.
const NEXT = '[data-testid="ocfSignupNextLink"]';
const SUBMIT =
  '[data-testid="SignupButton"], [data-testid="LoginForm_Login_Button"]';
const ONBOARDING_SKIP =
  '[data-testid$="SkipButton"], [data-testid$="SkipForNowButton"]';
const ONBOARDING_NEXT =
  '[data-testid$="NextButton"], [data-testid$="NextLink"]';

// The Arkose challenge, read from its iframe: public key and blob from the
// frame's URL. Null when no such frame is attached.
function arkose(page) {
  const frame = frameFrom(page, 'arkoselabs.com');
  if (!frame) return null;
  const src = frame.url();
  return {
    publicKey: (src.match(/\/([A-F0-9-]{36})\//) || [])[1] || '',
    blob: decodeURIComponent((src.match(/[?&]data=([^&]+)/) || [])[1] || ''),
    subdomain: new URL(src).origin,
  };
}

async function solveArkose(s, ark) {
  const { CaptchaSolver } = await import('../../../dist/captcha/solver.js');
  const token = await new CaptchaSolver().solveFuncaptcha(
    ark.publicKey,
    'https://x.com/i/flow/signup',
    ark.subdomain,
    ark.blob,
  );
  // Twitter's Arkose iframe posts the token to the page; the same message
  // shape injected from the page completes the challenge.
  await s.page.evaluate((tk) => {
    const message = JSON.stringify({
      eventId: 'challenge-complete',
      payload: { sessionToken: tk },
    });
    window.postMessage(message, '*');
    for (const iframe of document.querySelectorAll('iframe')) {
      if (iframe.src.includes('arkoselabs'))
        iframe.contentWindow?.postMessage(message, '*');
    }
  }, token);
  await pageSettled(s.page);
}

// Which input the flow's current step asks for: the first visible one of the
// fields the signup flow has, or null on a step with none (a prompt page).
async function step(page) {
  if (await field(page, 'password')) return 'password';
  if (
    (await autocompleteField(page, 'one-time-code')) ||
    (await field(page, 'verfication_code'))
  )
    return 'code';
  if (await field(page, 'email')) return 'email';
  if (await field(page, 'phone_number')) return 'phone';
  if (await field(page, 'name')) return 'name';
  return null;
}

// Clicks the first visible control of `selector` with a trusted click
// (Arkose-gated submits reject one dispatched from the page); false when none.
async function press(page, selector) {
  const found = page.locator(selector).first();
  if (!(await found.isVisible())) return false;
  await humanClickLocator(page, found);
  return true;
}

async function signup(s) {
  const id = await s.generateIdentity('twitter');
  const name = `${id.firstName} ${id.lastName}`;
  console.log(`[tw] identity: ${id.username} / ${id.email}`);
  const page = s.page;

  await s.ctx.addCookies([
    { name: 'lang', value: 'en', domain: '.x.com', path: '/' },
  ]);
  await s.goto(URL);
  await pageSettled(page);

  if (await clickFirst(page, 'button', ['Refuse non-essential cookies']))
    await pageSettled(page);

  // A page that offers only a retry is Twitter's own error page.
  if (
    !(await control(page, 'button', 'Create account')) &&
    (await control(page, 'button', 'Retry'))
  ) {
    console.log('[tw] got error page, retrying...');
    throw new Error('page_error');
  }

  await s.click('Create account');
  await pageSettled(page);
  await s.fill('Name', name);
  await pageSettled(page);

  if (await clickFirst(page, 'button', ['Use email instead']))
    await pageSettled(page);

  const contact = await step(page);
  if (contact === 'email') {
    await s.fill('Email', id.email);
  } else if (contact === 'phone') {
    const phone = await s.checkSms('twitter', 'UK');
    console.log(`[tw] SMS: ${phone}`);
    await s.fill('Phone', s.resolveEnv('$TWITTER_NEW_PHONE'));
  } else {
    throw new Error(
      `signup form offers neither an email nor a phone field; step ${contact}`,
    );
  }
  await pageSettled(page);

  await s.select('Month', id.birthMonth);
  await s.select('Day', id.birthDay);
  await s.select('Year', id.birthYear);
  await pageSettled(page);

  if (!(await press(page, NEXT)))
    throw new Error('signup form offers no Next after the date of birth');
  console.log('[tw] clicked Next, waiting for page change...');

  // Each round reads what the page now offers and acts on it: the Arkose
  // frame, the Authenticate button, a prompt page with only Next, the
  // logged-out home, or the next input of the flow. Rounds continue until the
  // flow asks for the code or the password, or lands on the logged-out home.
  for (;;) {
    await pageSettled(page);
    const current = await step(page);
    console.log(`[tw] waiting: url=${page.url()} step=${current}`);

    const ark = arkose(page);
    if (ark) {
      if (!ark.publicKey) {
        console.log('[tw] Arkose frame without a public key; waiting');
        continue;
      }
      console.log(
        `[tw] Arkose detected, solving via FunCaptcha API: pk=${ark.publicKey}`,
      );
      await solveArkose(s, ark);
      continue;
    }
    if (current === 'code' || current === 'password') break;
    if (await clickFirst(page, 'button', ['Authenticate'])) continue;
    if (current === null && (await press(page, NEXT))) continue;
    if (
      page.url() === 'https://x.com/' &&
      (await control(page, 'link', 'Sign in'))
    )
      throw new Error('flow_lost');
  }

  if ((await step(page)) === 'code') {
    if (contact === 'phone') {
      console.log('[tw] phone verification...');
      const code = await s.pollSmsCode();
      console.log(`[tw] SMS code: ${code}`);
      await s.fill('code', code);
    } else {
      console.log('[tw] email verification...');
      const code = await s.checkEmail(id.email, 'x.com');
      console.log(`[tw] email code: ${code}`);
      await s.fill('code', code);
    }
    await pageSettled(page);
    await s.click('Next');
    await pageSettled(page);
    // A flow that still asks for the code did not accept it: Twitter rejected
    // the code or the challenge behind it.
    if ((await step(page)) === 'code') {
      console.log('[tw] code not accepted, retrying...');
      throw new Error('code_rejected');
    }
  }

  await pageSettled(page);
  if ((await step(page)) === 'password') {
    await s.fill('Password', id.password);
    await pageSettled(page);
    if (!(await press(page, SUBMIT))) await s.press('Enter');
    await pageSettled(page);
  }

  // Skip onboarding steps until the home feed: each step's own Skip control
  // first, its Next control when it has no Skip. A step offering neither
  // ends the walk, and the home feed is opened directly.
  for (;;) {
    const url = page.url();
    console.log(`[tw] onboarding: url=${url}`);
    if (url.includes('/home')) break;
    if (
      url === 'https://x.com/' ||
      !(
        (await press(page, ONBOARDING_SKIP)) ||
        (await press(page, ONBOARDING_NEXT))
      )
    ) {
      await s.goto(HOME);
      await pageSettled(page);
      break;
    }
    await pageSettled(page);
  }

  // Success is the session's auth cookies, not what the page says.
  const cookies = await s.ctx.cookies();
  const authCookies = cookies.filter(
    (c) =>
      (c.domain?.includes('.x.com') || c.domain?.includes('.twitter.com')) &&
      (c.name === 'auth_token' || c.name === 'ct0'),
  );
  if (authCookies.length < 2) {
    console.log(
      `[tw] no auth cookies found (url=${page.url()}, cookies=${authCookies.map((c) => c.name)})`,
    );
    throw new Error('no_auth_cookies');
  }
  console.log(
    `[tw] auth cookies verified: ${authCookies.map((c) => c.name).join(', ')}`,
  );

  const result = await s.saveAccount('twitter', {
    username: id.username,
    email: id.email,
    password: id.password,
    name,
  });
  console.log(`[tw] ${result}`);
  const bound = await autoBindCharacter(id.username, 'twitter');
  console.log(`[bind] ${JSON.stringify(bound)}`);
  return id.username;
}

// Chromium only: Weles's fill path needs its devtools session.
const s = await WSession.start({ label: 'twitter_register', proxy });
try {
  const username = await signup(s);
  console.log(`PASS: ${username}`);
  await s.close();
  process.exit(0);
} catch (e) {
  console.log(`FAIL: ${e.message}`);
  await s.close();
  process.exitCode = 1;
}
