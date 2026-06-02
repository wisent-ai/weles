import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertLinkedinAuthenticatedRegistration, assertLinkedinDedicatedIspProxy, assertLinkedinProxyStable, assertLinkedinRegisterProxyRequest, classifyLinkedinRegisterFailure, getLinkedinChallengeSignal, getLinkedinFailureDiagnostics, summarizeLinkedinProxyState } from '../scripts/trajectories/_shared/linkedin/register_guard.mjs';

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
    expect(classifyLinkedinRegisterFailure('ACCOUNT_PERSIST_FAILED: error: no SUPABASE_URL', 'https://www.linkedin.com/feed/')).toBe('account_persist_failed');
    expect(classifyLinkedinRegisterFailure('DETECTION_TRIGGERED: createAccount challengeUrl', 'https://www.linkedin.com/signup')).toBe('detection_triggered');
    expect(classifyLinkedinRegisterFailure('x', 'https://www.linkedin.com/checkpoint/challenge')).toBe('captcha_challenge');
    expect(classifyLinkedinRegisterFailure('signup_did_not_authenticate: stage=test', 'https://www.linkedin.com/feed/')).toBe('registration_not_accepted');
    expect(classifyLinkedinRegisterFailure('signup_verification_incomplete: stage=test', 'https://www.linkedin.com/feed/')).toBe('registration_not_accepted');
    expect(classifyLinkedinRegisterFailure('signup_verification_incomplete: stage=test', 'https://www.linkedin.com/checkpoint/email-verification')).toBe('registration_not_accepted');
    expect(classifyLinkedinRegisterFailure('signup_form_unavailable: {}', 'https://www.linkedin.com/')).toBe('form_unavailable');
  });

  it('passes stable dedicated ISP exits and rejects drift', async () => {
    await expect(assertLinkedinProxyStable(fakeSession('50.117.105.62'), 'test')).resolves.toBe('50.117.105.62');
    await expect(assertLinkedinProxyStable(fakeSession('2606:4700:4700::1111'), 'test')).resolves.toBe('2606:4700:4700::1111');
    await expect(assertLinkedinProxyStable(fakeSession('50.117.105.63', '50.117.105.62'), 'test'))
      .rejects.toThrow(/PROXY_DRIFT/);
    await expect(assertLinkedinProxyStable(fakeSession('proxy auth failed'), 'test'))
      .rejects.toThrow(/invalid_exit_ip/);
    await expect(assertLinkedinProxyStable(fakeSession('::::'), 'test'))
      .rejects.toThrow(/invalid_exit_ip/);
    await expect(assertLinkedinProxyStable(fakeSession('deadbeef'), 'test'))
      .rejects.toThrow(/invalid_exit_ip/);
  });

  it('rejects obvious rotating proxy forms', () => {
    expect(() => assertLinkedinDedicatedIspProxy(fakeSession('1.1.1.1'), 'residential oxylabs us')).toThrow(/PROXY_NOT_DEDICATED_ISP/);
    expect(() => assertLinkedinDedicatedIspProxy({ proxyConfig: { server: 'http://pr.oxylabs.io:7777', username: 'customer-x-cc-us-sessid-1' } }, 'http://x')).toThrow(/PROXY_NOT_DEDICATED_ISP/);
    expect(() => assertLinkedinDedicatedIspProxy({ proxyConfig: { server: 'http://127.0.0.1:8001', proxy_type: 'residential' } }, 'isp decodo us')).toThrow(/PROXY_NOT_DEDICATED_ISP/);
    expect(() => assertLinkedinDedicatedIspProxy({ proxyConfig: { server: 'http://127.0.0.1:8001', proxy_type: 'url_unclassified' } }, 'http://user:pass@proxy.example.test:8001')).toThrow(/PROXY_NOT_DEDICATED_ISP/);
    expect(() => assertLinkedinDedicatedIspProxy(fakeSession('1.1.1.1'), 'isp oxylabs us')).toThrow(/retired_linkedin_proxy/);
    expect(() => assertLinkedinDedicatedIspProxy({ proxyConfig: { server: 'http://isp.oxylabs.io:8003', proxy_type: 'isp' } }, 'isp decodo us')).toThrow(/retired_linkedin_proxy/);
    expect(() => assertLinkedinDedicatedIspProxy({ proxyConfig: { server: 'http://127.0.0.1:8001', provider: 'oxylabs', proxy_type: 'isp' } }, 'isp decodo us')).toThrow(/retired_linkedin_proxy/);
    expect(() => assertLinkedinDedicatedIspProxy({ proxyConfig: { server: 'http://127.0.0.1:8001' } }, 'isp decodo us')).toThrow(/missing_proxy_type/);
    expect(() => assertLinkedinDedicatedIspProxy({ proxyConfig: { server: 'http://127.0.0.1:8001', proxy_type: 'isp' } }, 'isp decodo us')).not.toThrow();
  });

  it('rejects invalid LinkedIn register proxy requests before launch', () => {
    expect(() => assertLinkedinRegisterProxyRequest('isp decodo us')).not.toThrow();
    expect(() => assertLinkedinRegisterProxyRequest('')).toThrow(/PROXY_NOT_DEDICATED_ISP/);
    expect(() => assertLinkedinRegisterProxyRequest('direct')).toThrow(/PROXY_NOT_DEDICATED_ISP/);
    expect(() => assertLinkedinRegisterProxyRequest('residential decodo us')).toThrow(/PROXY_NOT_DEDICATED_ISP/);
    expect(() => assertLinkedinRegisterProxyRequest('http://user:pass@proxy.example.test:8001')).toThrow(/url_form_proxy_request/);
    expect(() => assertLinkedinRegisterProxyRequest('isp oxylabs us')).toThrow(/retired_linkedin_proxy/);
    expect(() => assertLinkedinRegisterProxyRequest('decodo us')).toThrow(/missing_isp_request/);
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

  it('summarizes proxy diagnostics without leaking credentials', () => {
    const summary = summarizeLinkedinProxyState({
      proxyConfig: {
        server: 'http://127.0.0.1:8001',
        username: 'secret-user',
        password: 'secret-pass',
        provider: 'oxylabs',
        proxy_type: 'isp',
        platform: 'isp',
        country: 'US',
        exit_ip: '50.117.105.62',
      },
    }, 'http://user:pass@example.invalid:1234', '50.117.105.61');
    expect(summary).toEqual({
      requested: '[url-form]',
      server_host: '127.0.0.1',
      server_port: '8001',
      server_scheme: 'http',
      provider: 'oxylabs',
      proxy_type: 'isp',
      platform: 'isp',
      country: 'US',
      expected_exit_ip: '50.117.105.61',
      actual_exit_ip: '50.117.105.62',
    });
    expect(JSON.stringify(summary)).not.toMatch(/secret|user:pass/);
  });

  it('includes sanitized page and challenge diagnostics', async () => {
    const diagnostics = await getLinkedinFailureDiagnostics({
      proxyConfig: { server: 'http://127.0.0.1:8001', proxy_type: 'isp', provider: 'decodo', exit_ip: '50.117.105.62' },
      page: {
        url: () => 'https://www.linkedin.com/checkpoint/challengeIframe/AQH123',
        evaluate: async () => ({
          url: 'https://www.linkedin.com/checkpoint/challengeIframe/AQH123',
          title: 'Security verification',
          pageKey: '',
          inputs: [{ name: 'email-address', id: 'email-address', type: 'email', autocomplete: 'off', visible: true }],
          buttons: [{ tag: 'button', text: 'Continue', href: '' }],
          iframes: [{ id: '', name: '', title: '', src: 'https://www.linkedin.com/checkpoint/challengeIframe/AQH123' }],
          bodyText: 'Complete the security verification to continue',
        }),
      },
      ctx: { cookies: async () => [] },
    }, 'isp decodo us', '50.117.105.62');

    expect(diagnostics.challenge_signal).toBe('challenge_page');
    expect(diagnostics.page.inputs[0]).not.toHaveProperty('value');
    expect(JSON.stringify(diagnostics)).not.toMatch(/secret|password|li_at=/);
  });

  it('does not wire CAPTCHA bypass into LinkedIn registration', () => {
    const source = readFileSync(new URL('../scripts/trajectories/linkedin_register.mjs', import.meta.url), 'utf8');
    expect(source).not.toMatch(/CaptchaSolver|solveRecaptcha|solveLinkedinCheckpoint|LINKEDIN_REGISTER_TRY_CHALLENGE/);
    expect(source).toMatch(/'isp decodo us'/);
    expect(source).not.toMatch(/'isp oxylabs us'/);
    expect(source).toMatch(/assertLinkedinRegisterProxyRequest/);
    expect(source.indexOf('assertLinkedinRegisterProxyRequest(requestedProxy)')).toBeGreaterThan(-1);
    expect(source.indexOf('assertLinkedinRegisterProxyRequest(requestedProxy)')).toBeLessThan(source.indexOf('s = await WSession.start'));
    expect(source).toMatch(/DETECTION_TRIGGERED: createAccount challengeUrl/);
    expect(source).toMatch(/assertNoLinkedinChallengePage/);
    expect(source).toMatch(/after_submit_email_password/);
    expect(source).toMatch(/after_create_account/);
    expect(source).toMatch(/assertLinkedinAuthenticatedRegistration/);
    expect(source).toMatch(/saveVerifiedLinkedinAccount/);
    expect(source).toMatch(/ACCOUNT_PERSIST_FAILED/);
    expect(source).toMatch(/getLinkedinFailureDiagnostics/);
    expect(source).toMatch(/assertNoLinkedinChallengePage\(s, 'after_onboarding'\)[\s\S]*assertLinkedinAuthenticatedRegistration\(s, 'after_onboarding'\)/);
    expect(source).toMatch(/after_onboarding[\s\S]*saveVerifiedLinkedinAccount[\s\S]*PASS:/);
    expect(source.slice(0, source.indexOf('after_onboarding'))).not.toMatch(/PASS:/);
    expect(source).not.toMatch(/post-redirect URL|persisted .*cookies/);
  });
});
