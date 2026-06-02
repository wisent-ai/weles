import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertLinkedinAuthenticatedRegistration, assertLinkedinDedicatedIspProxy, assertLinkedinProxyStable, classifyLinkedinRegisterFailure, getLinkedinChallengeSignal } from '../scripts/trajectories/_shared/linkedin/register_guard.mjs';

function fakeSession(exitIp, expectedIp = exitIp, options = {}) {
  return {
    proxyConfig: { server: 'http://127.0.0.1:8001', exit_ip: expectedIp },
    page: {
      url: () => options.url ?? 'https://www.linkedin.com/feed/',
    },
    ctx: {
      cookies: async () => options.cookies ?? [],
      newPage: async () => ({
        goto: async () => {},
        locator: () => ({ innerText: async () => exitIp }),
        close: async () => {},
      }),
    },
  };
}

describe('LinkedIn register guard', () => {
  it('classifies proxy and challenge failures distinctly', () => {
    expect(classifyLinkedinRegisterFailure('PROXY_DRIFT: expected=1 actual=2', 'https://www.linkedin.com/signup')).toBe('proxy_failed');
    expect(classifyLinkedinRegisterFailure('PROXY_NOT_DEDICATED_ISP: residential', 'https://www.linkedin.com/signup')).toBe('proxy_failed');
    expect(classifyLinkedinRegisterFailure('DETECTION_TRIGGERED: createAccount challengeUrl', 'https://www.linkedin.com/signup')).toBe('detection_triggered');
    expect(classifyLinkedinRegisterFailure('x', 'https://www.linkedin.com/checkpoint/challenge')).toBe('captcha_challenge');
    expect(classifyLinkedinRegisterFailure('signup_did_not_authenticate: stage=test', 'https://www.linkedin.com/feed/')).toBe('registration_not_accepted');
    expect(classifyLinkedinRegisterFailure('signup_verification_incomplete: stage=test', 'https://www.linkedin.com/feed/')).toBe('registration_not_accepted');
    expect(classifyLinkedinRegisterFailure('signup_verification_incomplete: stage=test', 'https://www.linkedin.com/checkpoint/email-verification')).toBe('registration_not_accepted');
    expect(classifyLinkedinRegisterFailure('signup_form_unavailable: {}', 'https://www.linkedin.com/')).toBe('form_unavailable');
  });

  it('passes stable dedicated ISP exits and rejects drift', async () => {
    await expect(assertLinkedinProxyStable(fakeSession('50.117.105.62'), 'test')).resolves.toBe('50.117.105.62');
    await expect(assertLinkedinProxyStable(fakeSession('50.117.105.63', '50.117.105.62'), 'test'))
      .rejects.toThrow(/PROXY_DRIFT/);
    await expect(assertLinkedinProxyStable(fakeSession('proxy auth failed'), 'test'))
      .rejects.toThrow(/invalid_exit_ip/);
  });

  it('rejects obvious rotating proxy forms', () => {
    expect(() => assertLinkedinDedicatedIspProxy(fakeSession('1.1.1.1'), 'residential oxylabs us')).toThrow(/PROXY_NOT_DEDICATED_ISP/);
    expect(() => assertLinkedinDedicatedIspProxy({ proxyConfig: { server: 'http://pr.oxylabs.io:7777', username: 'customer-x-cc-us-sessid-1' } }, 'http://x')).toThrow(/PROXY_NOT_DEDICATED_ISP/);
    expect(() => assertLinkedinDedicatedIspProxy(fakeSession('1.1.1.1'), 'isp oxylabs us')).not.toThrow();
  });

  it('detects challenge pages without treating email verification as CAPTCHA', () => {
    expect(getLinkedinChallengeSignal({
      url: 'https://www.linkedin.com/checkpoint/challengeIframe/AQH123',
      iframes: [{ src: 'https://www.linkedin.com/checkpoint/challengeIframe/AQH123' }],
    })).toBe('challenge_page');
    expect(getLinkedinChallengeSignal({
      url: 'https://www.linkedin.com/checkpoint/',
      title: 'Security verification',
      bodyText: 'Complete the captcha to continue',
    })).toBe('challenge_page');
    expect(getLinkedinChallengeSignal({
      url: 'https://www.linkedin.com/checkpoint/email-verification',
      inputs: [{ autocomplete: 'one-time-code', name: 'pin' }],
      bodyText: 'Enter the confirmation code sent to your email',
    })).toBe('');
  });

  it('requires authenticated LinkedIn state before registration success', async () => {
    const authed = fakeSession('1.1.1.1', '1.1.1.1', {
      cookies: [{ domain: '.linkedin.com', name: 'li_at', value: 'cookie-value', expires: 123 }],
      url: 'https://www.linkedin.com/feed/',
    });
    await expect(assertLinkedinAuthenticatedRegistration(authed, 'test')).resolves.toMatchObject({ has_li_at: true });

    await expect(assertLinkedinAuthenticatedRegistration(fakeSession('1.1.1.1'), 'test'))
      .rejects.toThrow(/signup_did_not_authenticate/);
    await expect(assertLinkedinAuthenticatedRegistration(fakeSession('1.1.1.1', '1.1.1.1', {
      cookies: [{ domain: '.linkedin.com', name: 'li_at', value: 'cookie-value' }],
      url: 'https://www.linkedin.com/signup',
    }), 'test')).rejects.toThrow(/signup_did_not_complete/);
    await expect(assertLinkedinAuthenticatedRegistration(fakeSession('1.1.1.1', '1.1.1.1', {
      cookies: [{ domain: '.linkedin.com', name: 'li_at', value: 'cookie-value' }],
      url: 'https://www.linkedin.com/checkpoint/email-verification',
    }), 'test')).rejects.toThrow(/signup_verification_incomplete/);
    await expect(assertLinkedinAuthenticatedRegistration(fakeSession('1.1.1.1', '1.1.1.1', {
      cookies: [{ domain: '.linkedin.com', name: 'li_at', value: 'cookie-value' }],
      url: 'https://www.linkedin.com/checkpoint/challengeIframe/AQH123',
    }), 'test')).rejects.toThrow(/DETECTION_TRIGGERED/);
  });

  it('does not wire CAPTCHA bypass into LinkedIn registration', () => {
    const source = readFileSync(new URL('../scripts/trajectories/linkedin_register.mjs', import.meta.url), 'utf8');
    expect(source).not.toMatch(/CaptchaSolver|solveRecaptcha|solveLinkedinCheckpoint|LINKEDIN_REGISTER_TRY_CHALLENGE/);
    expect(source).toMatch(/DETECTION_TRIGGERED: createAccount challengeUrl/);
    expect(source).toMatch(/assertNoLinkedinChallengePage/);
    expect(source).toMatch(/assertLinkedinAuthenticatedRegistration/);
  });
});
