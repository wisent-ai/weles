import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertLinkedinDedicatedIspProxy, assertLinkedinProxyStable, classifyLinkedinRegisterFailure } from '../scripts/trajectories/_shared/linkedin/register_guard.mjs';

function fakeSession(exitIp, expectedIp = exitIp) {
  return {
    proxyConfig: { server: 'http://127.0.0.1:8001', exit_ip: expectedIp },
    ctx: {
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
    expect(classifyLinkedinRegisterFailure('signup_form_unavailable: {}', 'https://www.linkedin.com/')).toBe('form_unavailable');
  });

  it('passes stable dedicated ISP exits and rejects drift', async () => {
    await expect(assertLinkedinProxyStable(fakeSession('50.117.105.62'), 'test')).resolves.toBe('50.117.105.62');
    await expect(assertLinkedinProxyStable(fakeSession('50.117.105.63', '50.117.105.62'), 'test'))
      .rejects.toThrow(/PROXY_DRIFT/);
  });

  it('rejects obvious rotating proxy forms', () => {
    expect(() => assertLinkedinDedicatedIspProxy(fakeSession('1.1.1.1'), 'residential oxylabs us')).toThrow(/PROXY_NOT_DEDICATED_ISP/);
    expect(() => assertLinkedinDedicatedIspProxy({ proxyConfig: { server: 'http://pr.oxylabs.io:7777', username: 'customer-x-cc-us-sessid-1' } }, 'http://x')).toThrow(/PROXY_NOT_DEDICATED_ISP/);
    expect(() => assertLinkedinDedicatedIspProxy(fakeSession('1.1.1.1'), 'isp oxylabs us')).not.toThrow();
  });

  it('does not wire CAPTCHA bypass into LinkedIn registration', () => {
    const source = readFileSync(new URL('../scripts/trajectories/linkedin_register.mjs', import.meta.url), 'utf8');
    expect(source).not.toMatch(/CaptchaSolver|solveRecaptcha|solveLinkedinCheckpoint|LINKEDIN_REGISTER_TRY_CHALLENGE/);
    expect(source).toMatch(/DETECTION_TRIGGERED: createAccount challengeUrl/);
  });
});
