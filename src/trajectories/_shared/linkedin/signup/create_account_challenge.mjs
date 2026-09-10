// LinkedIn createAccount challenge handler.
//
// After /signup/api/cors/createAccount returns challengeUrl, LinkedIn either
// renders the challenge inline on /signup or loads it inside
// /checkpoint/challengeIframe/.... This module detects the challenge type
// (phone verification or captcha), navigates to the challenge iframe when
// needed, solves it, and returns control to the normal post-createAccount flow.

import { isChallengeCleared, waitForChallenge } from './create_account_challenge/detect.mjs';
import { solveLinkedinCaptchaChallenge } from './create_account_challenge/captcha_solve.mjs';
import { humanIdlePause } from '../../../../../dist/human/mouse.js';
import { solveLinkedinPhoneChallenge } from './phone_verify.mjs';

const DEFAULT_COUNTRY = 'US';
const CHALLENGE_WAIT_SECS = 12;




async function solveChallengeInPage(page, session, country) {
  const challenge = await waitForChallenge(page, CHALLENGE_WAIT_SECS);
  if (!challenge) throw new Error('create_account_challenge: no recognizable challenge UI appeared in challenge page');

  console.log(`[create_account_challenge] detected ${challenge.kind} in challenge page`);

  if (challenge.kind === 'phone_verification') {
    await solveLinkedinPhoneChallenge(session, country);
    return { kind: 'phone_verification', solved: true };
  }

  if (challenge.kind === 'captcha') {
    await solveLinkedinCaptchaChallenge(page, session?.proxyConfig);
    console.log('[create_account_challenge] captcha solved, waiting for challenge to clear...');
    for (let i = 0; i < 30; i++) {
      if (await isChallengeCleared(page)) return { kind: 'captcha', solved: true };
      const phoneFrame = page.locator('input[name="phoneNumber"]').first();
      const hasPhone = await phoneFrame.count() && await phoneFrame.isVisible({ timeout: 1000 }).catch(() => false);
      if (hasPhone) {
        await solveLinkedinPhoneChallenge(session, country);
        return { kind: 'captcha_then_phone', solved: true };
      }
      await humanIdlePause('short');
    }
    return { kind: 'captcha', solved: true };
  }

  throw new Error(`create_account_challenge: unsupported challenge kind ${challenge.kind}`);
}

/**
 * Wait for the createAccount challenge UI and solve it.
 *
 * @param {WSession} session
 * @param {Object} [opts]
 * @param {string} [opts.country='US']
 * @param {string} [opts.challengeUrl=''] - LinkedIn challengeUrl from createAccount response
 * @returns {Promise<{kind: string, solved: boolean}>}
 */
export async function handleCreateAccountChallenge(session, opts = {}) {
  const page = session.page;
  const country = opts.country ?? DEFAULT_COUNTRY;
  const challengeUrl = opts.challengeUrl ?? '';

  console.log('[create_account_challenge] waiting for challenge UI...');
  let challenge = await waitForChallenge(page, CHALLENGE_WAIT_SECS);

  // LinkedIn sometimes renders the challenge inside /checkpoint/challengeIframe/...
  // rather than inline on /signup. Navigate there and solve it.
  if (!challenge && challengeUrl && challengeUrl.startsWith('/checkpoint/')) {
    const absoluteUrl = new URL(challengeUrl, 'https://www.linkedin.com/').toString();
    console.log(`[create_account_challenge] navigating to challenge iframe ${absoluteUrl}`);
    await page.goto(absoluteUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await humanIdlePause('deliberate');
    console.log(`[create_account_challenge] challenge page url=${page.url()}`);
    return solveChallengeInPage(page, session, country);
  }

  if (!challenge) throw new Error('create_account_challenge: no recognizable challenge UI appeared');

  return solveChallengeInPage(page, session, country);
}
