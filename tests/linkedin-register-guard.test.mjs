import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertLinkedinAuthenticatedRegistration, assertLinkedinDedicatedIspProxy, assertLinkedinProxyStable, assertLinkedinRegisterProxyRequest, classifyLinkedinRegisterFailure, getLinkedinChallengeSignal, getLinkedinFailureDiagnostics, linkedinRegisterExitCode, summarizeLinkedinProxyState } from '../scripts/trajectories/_shared/linkedin/register_guard.mjs';

function fakeSession(exitIp, expectedIp = exitIp, options = {}) {
  return {
    proxyConfig: { server: 'http://127.0.0.1:8001', exit_ip: expectedIp },
    page: {
      url: () => options.url ?? 'https://www.linkedin.com/feed/',
    },
    ctx: {
      cookies: async () => options.cookies ?? [],
      request: {
        get: async () => ({
          text: async () => exitIp,
        }),
      },
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

  it('maps failure signals to deterministic exit codes', () => {
    expect(linkedinRegisterExitCode('detection_triggered')).toBe(2);
    expect(linkedinRegisterExitCode('captcha_challenge')).toBe(2);
    expect(linkedinRegisterExitCode('proxy_failed')).toBe(3);
    expect(linkedinRegisterExitCode('registration_not_accepted')).toBe(4);
    expect(linkedinRegisterExitCode('account_persist_failed')).toBe(5);
    expect(linkedinRegisterExitCode('form_unavailable')).toBe(1);
    expect(linkedinRegisterExitCode('action_failed')).toBe(1);
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
    expect(getLinkedinChallengeSignal({
      url: 'https://www.linkedin.com/signup',
      title: 'Sign Up | LinkedIn',
      pageKey: 'd_registration-signup',
      inputs: [{ name: 'email-address', id: 'email-address', type: 'email', visible: true }],
      iframes: [{ title: 'Security verification', src: 'about:blank', visible: false }],
      bodyText: 'Join LinkedIn now Email Password Agree & Join',
    })).toBe('');
    expect(getLinkedinChallengeSignal({
      url: 'https://www.linkedin.com/signup',
      title: 'Sign Up | LinkedIn',
      pageKey: 'd_registration-signup',
      inputs: [
        { name: 'email-address', id: 'email-address', type: 'email', visible: true },
        { name: 'password', id: 'password', type: 'password', visible: true },
      ],
      iframes: [
        { title: 'Security verification', src: 'about:blank', visible: false },
        { title: '', src: 'https://li.protechts.net/index.html?uc=scraping', visible: false },
        { title: 'reCAPTCHA', src: 'https://www.google.com/recaptcha/enterprise/anchor?ar=1&k=sitekey&size=invisible', visible: true },
      ],
      bodyText: 'Join LinkedIn now Email Password Agree & Join',
    })).toBe('');
    expect(getLinkedinChallengeSignal({
      url: 'https://www.linkedin.com/signup',
      iframes: [{ title: 'Security verification', src: 'about:blank', visible: true }],
    })).toBe('challenge_page');
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
    expect(source).toMatch(/process\.exitCode = linkedinRegisterExitCode\(sig\)/);
    expect(source).not.toMatch(/process\.exitCode = e\.message\?\.startsWith\('DETECTION_TRIGGERED'\)/);
    expect(source).toMatch(/DETECTION_TRIGGERED: createAccount challengeUrl/);
    expect(source).not.toMatch(/linkedin_register_creds|LINKEDIN_NEW_|autocomplete','off'|attempted_email: id\.email|details: \{[^}]*email: id\.email|details: \{[^}]*username: id\.handle/);
    expect(source).not.toMatch(/waitForFunction/);
    expect(source).toMatch(/searchParams\.get\('size'\) === 'invisible'/);
    expect(source).toMatch(/getBoundingClientRect\(\)\.height > 120/);
    expect(source).toMatch(/grecaptcha-badge/);
    expect(source).not.toMatch(/\[class\*="captcha" i\]/);
    expect(source).not.toMatch(/iframe\\\[src\\\*=.*recaptcha.*\\\][\s\S]*count\(\)/);
    expect(source).toMatch(/attempted_email_hash/);
    expect(source).toMatch(/email_hash/);
    expect(source).toMatch(/assertNoLinkedinChallengePage/);
    expect(source).toMatch(/after_submit_email_password/);
    expect(source).toMatch(/after_create_account/);
    expect(source).toMatch(/assertLinkedinAuthenticatedRegistration/);
    expect(source).toMatch(/saveVerifiedLinkedinAccount/);
    expect(source).toMatch(/ACCOUNT_PERSIST_FAILED/);
    expect(source).toMatch(/getLinkedinFailureDiagnostics/);
    expect(source).toMatch(/WELES_REGISTER_BROWSER/);
    expect(source).toMatch(/WELES_REGISTER_OS/);
    expect(source).toMatch(/assertNoLinkedinChallengePage\(s, 'after_onboarding'\)[\s\S]*assertLinkedinAuthenticatedRegistration\(s, 'after_onboarding'\)[\s\S]*assertLinkedinProxyStable\(s, 'before_account_persist'/);
    expect(source).toMatch(/before_account_persist[\s\S]*saveVerifiedLinkedinAccount[\s\S]*PASS:/);
    expect(source.slice(0, source.indexOf('after_onboarding'))).not.toMatch(/PASS:/);
    expect(source).not.toMatch(/post-redirect URL|persisted .*cookies/);
  });

  it('does not expose Weles-named error globals from fingerprint shims', () => {
    const chrome147 = readFileSync(new URL('../src/scripts/chrome147_stubs.js', import.meta.url), 'utf8');
    const navigatorShim = readFileSync(new URL('../src/scripts/navigator.js', import.meta.url), 'utf8');
    expect(chrome147).not.toMatch(/__WELES_/);
    expect(navigatorShim).not.toMatch(/__WELES_/);
  });

  it('does not write full proxy strings into session metadata', () => {
    const source = readFileSync(new URL('../src/session/wsession.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/proxy_full/);
    expect(source).toMatch(/proxy_user_hash/);
    expect(source).toMatch(/proxy_user_present/);
    expect(source).toMatch(/resolveChromiumPathOverride/);
    expect(source).toMatch(/ignoring missing Chromium path/);
    expect(source).toMatch(/existsSync\(p\)/);
    const guardSource = readFileSync(new URL('../scripts/trajectories/_shared/linkedin/register_guard.mjs', import.meta.url), 'utf8');
    expect(guardSource).toMatch(/session\.ctx\.request\.get\('https:\/\/api\.ipify\.org'/);
    expect(guardSource.slice(guardSource.indexOf('export async function assertLinkedinProxyStable'))).not.toMatch(/newPage\(/);
  });

  it('does not write raw proxy credentials into instrumentation dumps', () => {
    const source = readFileSync(new URL('../src/session/wsession-helpers/net_record.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/sanitizeProxyConfig/);
    expect(source).toMatch(/username_present/);
    expect(source).toMatch(/username_hash/);
    expect(source).toMatch(/password_present/);
    expect(source).not.toMatch(/proxy: ws\.proxyConfig/);
    expect(source).toMatch(/JSON\.parse\(body\)/);
    expect(source).toMatch(/emailAddress/);
    expect(source).toMatch(/session_password/);
    expect(source).toMatch(/postDataRedacted/);
    expect(source).toMatch(/if \(b && !redactedPost\.redacted\)/);
  });

  it('keeps previously toxic diagnostics in safe modes by default', () => {
    const asyncSource = readFileSync(new URL('../src/async_api.ts', import.meta.url), 'utf8');
    const cdpSource = readFileSync(new URL('../src/session/wsession-helpers/capture_extras.ts', import.meta.url), 'utf8');
    const netSource = readFileSync(new URL('../src/session/wsession-helpers/net_record.ts', import.meta.url), 'utf8');
    expect(asyncSource).toMatch(/function chromiumNetlogConfig/);
    expect(asyncSource).toMatch(/WELES_FULL_DIAGNOSTICS/);
    expect(asyncSource).toMatch(/includeCaptureMode: mode === 'everything'/);
    expect(asyncSource).not.toMatch(/args\.push\('--net-log-capture-mode=Everything'\);[\s\S]{0,120}args\.push\('--log-net-log/);
    expect(cdpSource).toMatch(/cdpFirehoseMode/);
    expect(cdpSource).toMatch(/'passive'/);
    expect(cdpSource).toMatch(/WELES_CDP_FIREHOSE_MODE=enable-domains/);
    expect(cdpSource).toMatch(/ws\._instCdpFirehoseMode === 'enable-domains'/);
    expect(cdpSource).toMatch(/WELES_CDP_FIREHOSE_LIMIT/);
    expect(netSource).toMatch(/cdp_firehose_mode/);
  });

  it('probes the LinkedIn register surface instead of accepting login false positives', () => {
    const source = readFileSync(new URL('../src/proxy/policy.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/function probeLinkedinSignup/);
    expect(source).toMatch(/persona\?: LinkedInProbePersona/);
    expect(source).toMatch(/function linkedinProbeHeaders/);
    expect(source).toMatch(/const targetUrl = 'https:\/\/www\.linkedin\.com\/signup'/);
    expect(source).not.toMatch(/const targetUrl = 'https:\/\/www\.linkedin\.com\/login'/);
    expect(source).toMatch(/sec-fetch-mode/);
    expect(source).toContain("'sec-ch-ua': `\"Google Chrome\";v=\"${chromeMajor}\", \"Not.A/Brand\";v=\"8\", \"Chromium\";v=\"${chromeMajor}\"`,");
    expect(source).toMatch(/join-form-submit/);
    expect(source).toMatch(/challenge_dialog_template/);
    expect(source).toMatch(/security_verification_template/);
    expect(source).toMatch(/challenge-dialog/);
    expect(source).toMatch(/Security verification/);
    expect(source).toMatch(/bodyMarkers\.signup_form && !bodyMarkers\.hard_challenge/);
    expect(source).not.toMatch(/bodyMarkers\.login_form \|\| bodyMarkers\.signup_form/);
  });

  it('passes the browser persona into LinkedIn proxy preflight before launch', () => {
    const sessionSource = readFileSync(new URL('../src/session/wsession.ts', import.meta.url), 'utf8');
    const proxySource = readFileSync(new URL('../src/proxy/config.ts', import.meta.url), 'utf8');
    expect(sessionSource.indexOf('const persona: Persona')).toBeLessThan(sessionSource.indexOf('await resolveProxy'));
    expect(sessionSource).toMatch(/resolveProxy\(opts\.proxy!, opts\.targetHost, persona\)/);
    expect(sessionSource).toMatch(/countryHintFromProxyRequest\(opts\.proxy\)/);
    expect(proxySource).toMatch(/preflightPersona\?: LinkedInProbePersona/);
    expect(proxySource).toMatch(/probeLinkedinSignup\(url, 8, preflightPersona\)/);
  });
});
