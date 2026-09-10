// Which challenge LinkedIn put in front of the new account, and whether it is gone.
import { humanIdlePause } from '../../../../../../dist/human/mouse.js';

export async function detectChallengeType(page) {
  // Phone verification: visible phone input.
  const phone = page.locator('input[name="phoneNumber"], input#register-verification-phone-number, input#phone-verification-phone-number, input[type="tel"]').filter({ visible: true }).first();
  if (await phone.count() && await phone.isVisible({ timeout: 1500 }).catch(() => false)) {
    return { kind: 'phone_verification', phoneInput: phone };
  }
  // Captcha challenge: LinkedIn wraps it in iframe#captcha-internal.
  const captchaIframe = page.locator('iframe#captcha-internal, iframe[title*="Captcha" i], iframe[src*="/checkpoint/challenge/captchaInternal"]').first();
  if (await captchaIframe.count() && await captchaIframe.isVisible({ timeout: 1500 }).catch(() => false)) {
    return { kind: 'captcha' };
  }
  // Generic captcha detection across all frames.
  const frames = page.frames();
  for (const frame of frames) {
    const hasCaptcha = await frame.evaluate(() => {
      return !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="arkoselabs"], iframe[src*="funcaptcha"], .g-recaptcha, .h-captcha, .cf-turnstile');
    }).catch(() => false);
    if (hasCaptcha) return { kind: 'captcha' };
  }
  return null;
}

export async function waitForChallenge(page, maxSecs) {
  for (let i = 0; i < maxSecs * 2; i++) {
    const detected = await detectChallengeType(page);
    if (detected) return detected;
    await humanIdlePause('short');
  }
  return null;
}

export async function isChallengeCleared(page) {
  const phone = page.locator('input[name="phoneNumber"], input#register-verification-phone-number').first();
  const captcha = page.locator('iframe#captcha-internal, iframe[title*="Captcha" i]').first();
  const hasPhone = await phone.count() && await phone.isVisible({ timeout: 1000 }).catch(() => false);
  const hasCaptcha = await captcha.count() && await captcha.isVisible({ timeout: 1000 }).catch(() => false);
  return !hasPhone && !hasCaptcha;
}
