// Solve LinkedIn's captcha challenge through the fleet's captcha solver and submit its token.
import { CaptchaSolver } from '../../../../../../dist/captcha/solver.js';
import { humanIdlePause } from '../../../../../../dist/human/mouse.js';
import { getCaptchaCredentials } from '../../../../../../dist/utils/credentials.js';
import { isChallengeCleared } from './detect.mjs';
import { getCaptchaSitekey, getChallengeDataS, submitLinkedinCaptchaForm } from './captcha_form.mjs';

export async function solveLinkedinCaptchaChallenge(page, proxy) {
  console.log('[create_account_challenge] waiting for captcha challenge iframe...');
  const iframe = page.locator('iframe#captcha-internal').first();
  for (let i = 0; i < 20; i++) {
    if (await iframe.count() && await iframe.isVisible({ timeout: 1000 }).catch(() => false)) break;
    await humanIdlePause('short');
  }

  const sitekey = await getCaptchaSitekey(page);
  if (!sitekey) throw new Error('create_account_challenge: captcha sitekey not found');
  console.log(`[create_account_challenge] captcha sitekey=${sitekey.slice(0, 16)}...`);
  console.log('[create_account_challenge] reading data-s...');
  const dataS = await Promise.race([
    getChallengeDataS(page),
    new Promise((_, reject) => setTimeout(() => reject(new Error('getChallengeDataS timeout')), 15_000)),
  ]).catch((e) => { console.log(`[create_account_challenge] data-s read failed: ${e.message?.slice(0, 80)}`); return null; });
  if (dataS) console.log(`[create_account_challenge] captcha data-s=${dataS.slice(0, 24)}...`);
  else console.log('[create_account_challenge] no data-s found, proceeding without it');

  // If a browser extension solver (e.g. NopeCHA) is active, give it a few
  // seconds to clear the challenge before we start firing API solvers.
  if (process.env.WELES_NOPECHA_EXT === '1') {
    console.log('[create_account_challenge] NopeCHA extension detected; waiting for it to solve...');
    for (let i = 0; i < 30; i++) {
      await humanIdlePause('short');
      if (await isChallengeCleared(page)) {
        console.log('[create_account_challenge] challenge cleared by extension solver');
        return;
      }
    }
    console.log('[create_account_challenge] extension did not clear challenge in time; falling back to API solvers');
  }

  // LinkedIn's invisible enterprise reCAPTCHA is picky. Try each captcha
  // provider in isolation and verify whether the challenge actually clears.
  // Some providers classify this key as V3/score-based, so try V3 first.
  const allCreds = await getCaptchaCredentials();
  const providerOrder = ['nopecha', 'capsolver', 'anticaptcha', 'capmonster', 'twocaptcha'];
  const challengeUrl = (typeof page.url === 'function' ? page.url() : page?.url) ?? 'https://www.linkedin.com/signup';
  const websiteUrl = challengeUrl;

  for (const provider of providerOrder) {
    const key = allCreds[provider];
    if (!key) continue;
    console.log(`[create_account_challenge] trying captcha provider: ${provider}`);
    const solver = new CaptchaSolver({ [provider]: key });

    // Attempt 1: reCAPTCHA v3 / score-based token.
    if (provider === 'capsolver' || provider === 'anticaptcha' || provider === 'nopecha') {
      const v3Token = await solver.solveRecaptchaV3(sitekey, websiteUrl, 'signup', { proxy, dataS, enterprise: true });
      if (v3Token && typeof v3Token === 'string') {
        console.log(`[create_account_challenge] ${provider} v3 token=${v3Token.slice(0, 20)}...`);
        const submitResult = await submitLinkedinCaptchaForm(page, v3Token, sitekey, dataS);
        if (submitResult.ok) {
          await humanIdlePause('medium');
          if (await isChallengeCleared(page)) {
            console.log(`[create_account_challenge] captcha cleared with ${provider} v3`);
            return;
          }
          console.log(`[create_account_challenge] ${provider} v3 token was rejected, retrying...`);
        } else {
          console.log(`[create_account_challenge] ${provider} v3 submit failed: ${submitResult.reason}`);
        }
      } else {
        console.log(`[create_account_challenge] ${provider} returned no v3 token`);
      }
    }

    // Attempt 2: reCAPTCHA v2 invisible enterprise token. LinkedIn wraps the
    // challenge with an enterprise invisible reCAPTCHA; the wrapper sitekey
    // inside the form may look like a plain v2 key, but the endpoint validates
    // it as enterprise, so request an enterprise token first.
    for (const entFlag of [true, false]) {
      const token = await solver.solveRecaptchaV2(page, sitekey, { enterprise: entFlag, invisible: true, url: websiteUrl, proxy, dataS });
      if (!token || typeof token !== 'string') {
        console.log(`[create_account_challenge] ${provider} returned no v2 token (enterprise=${entFlag})`);
        continue;
      }
      console.log(`[create_account_challenge] ${provider} v2 token=${token.slice(0, 20)}... (enterprise=${entFlag})`);

      const submitResult = await submitLinkedinCaptchaForm(page, token, sitekey, dataS);
      if (!submitResult.ok) {
        console.log(`[create_account_challenge] ${provider} v2 submit failed (enterprise=${entFlag}): ${submitResult.reason}`);
        continue;
      }

      await humanIdlePause('medium');
      if (await isChallengeCleared(page)) {
        console.log(`[create_account_challenge] captcha cleared with ${provider} v2 (enterprise=${entFlag})`);
        return;
      }
      console.log(`[create_account_challenge] ${provider} v2 token was rejected (enterprise=${entFlag}), retrying...`);
    }
  }
  throw new Error('create_account_challenge: all captcha providers failed to clear the challenge');
}
