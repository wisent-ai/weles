// The browser path into wisent-workspace.slack.com: Google SSO with a
// workspace-member @wisent.ai account, then the web client's own xoxc- token.
// Wisent Slack admits members by Google SSO, so this lands the user as a
// workspace member (a plain gmail attempt failed at membership).

// How long the Google button and the sign-in controls are given to answer a click.
const SSO_CLICK_WAIT_MS = 15000;
const CHALLENGE_CLICK_WAIT_MS = 10000;

/** Type the password when Google shows its field; false when it did not. */
async function fillPasswordWhenAvailable(page, password, atoms) {
  const pwd = page.locator('input[type="password"]');
  if (await pwd.count() === 0) return false;
  await atoms.humanFill(page, pwd, password);
  await page.keyboard.press('Enter');
  await atoms.humanIdlePause('long');
  return true;
}

/** Sign into the workspace through Google with the given credentials. */
export async function signInThroughGoogle(s, { email, password, shot, atoms }) {
  const { humanFill, humanClickLocator, humanIdlePause } = atoms;
  console.log(`[slack] step 1: Google SSO as ${email}`);
  await s.page.goto('https://wisent-workspace.slack.com', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');
  await shot('01-slack-landing');

  const googleBtn = s.page.getByRole('button', { name: /^\s*google\s*$/i })
    .or(s.page.getByRole('link', { name: /^\s*google\s*$/i }));
  await humanClickLocator(s.page, googleBtn.first(), { timeoutMs: SSO_CLICK_WAIT_MS });
  await humanIdlePause('long');
  await shot('02-google-email');

  await humanFill(s.page, s.page.locator('input[type="email"]').first(), email);
  await s.page.keyboard.press('Enter');
  await humanIdlePause('long');

  if (!await fillPasswordWhenAvailable(s.page, password, atoms)) {
    console.log('[slack] passkey challenge — Try another way → Enter your password');
    const tryOther = s.page.getByRole('button', { name: /try another way/i })
      .or(s.page.getByRole('link', { name: /try another way/i }));
    if (await tryOther.count() > 0) {
      await humanClickLocator(s.page, tryOther.first(), { timeoutMs: CHALLENGE_CLICK_WAIT_MS });
      await humanIdlePause('long');
      const enterPwd = s.page.getByText(/enter your password/i).first();
      if (await enterPwd.count() > 0) {
        await humanClickLocator(s.page, enterPwd, { timeoutMs: CHALLENGE_CLICK_WAIT_MS });
        await humanIdlePause('long');
        await fillPasswordWhenAvailable(s.page, password, atoms);
      }
    }
  }

  // Google's OAuth consent screen "Continue" button completes the handshake.
  const continueBtn = s.page.getByRole('button', { name: /^\s*continue\s*$/i });
  if (await continueBtn.count() > 0) {
    console.log('[slack] consent — clicking Continue');
    await humanClickLocator(s.page, continueBtn.first(), { timeoutMs: CHALLENGE_CLICK_WAIT_MS });
    await humanIdlePause('long');
    await shot('04d-after-consent');
  }
  console.log(`[slack] post-signin url=${s.page.url()}`);
}

/** The web client's xoxc- token from boot_data or localStorage, or false. */
export async function readClientToken(s, atoms) {
  console.log('[slack] step 2: load Slack web client + extract xoxc-');
  await s.page.goto('https://wisent-workspace.slack.com/messages', { waitUntil: 'domcontentloaded' });
  await atoms.humanIdlePause('long');
  return s.page.evaluate(() => {
    function findInLS() {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        const v = localStorage.getItem(k);
        if (typeof v !== 'string') continue;
        const m = v.match(/xoxc-[\d]+-[\d]+-[\d]+-[a-f0-9]+/);
        if (m) return m[0];
      }
      return false;
    }
    const bd = (typeof window !== 'undefined') ? window.boot_data : false;
    if (bd && bd.api_token) return bd.api_token;
    return findInLS();
  });
}
