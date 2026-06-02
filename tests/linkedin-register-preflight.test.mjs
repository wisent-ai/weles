import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function runLinkedinRegisterWithProxy(proxy) {
  const cwd = mkdtempSync(join(tmpdir(), 'linkedin-register-preflight-'));
  const script = resolve('scripts/trajectories/linkedin_register.mjs');
  const result = spawnSync(process.execPath, [script], {
    cwd,
    env: {
      ...process.env,
      LINKEDIN_REGISTER_PROXY: proxy,
      WELES_DISABLE_RECORDING: '1',
    },
    encoding: 'utf8',
  });
  const signalPath = join(cwd, 'recordings', 'linkedin_register', 'ban_signal.json');
  return { cwd, result, signalPath };
}

function expectNoSessionLaunch(result) {
  expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/\[wsession\] start\(\)/);
}

describe('LinkedIn register preflight', () => {
  it('fails invalid proxy requests before browser launch and writes ban_signal', () => {
    const { cwd, result, signalPath } = runLinkedinRegisterWithProxy('direct');
    try {
      expect(result.status).toBe(3);
      expectNoSessionLaunch(result);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/FAIL: PROXY_NOT_DEDICATED_ISP: requested=direct/);

      const signal = JSON.parse(readFileSync(signalPath, 'utf8'));
      expect(signal).toMatchObject({
        action: 'linkedin_register',
        signal: 'proxy_failed',
        healthy: false,
      });
      expect(signal.details).toMatchObject({
        final_url: '',
        attempted_email_hash: null,
        expected_exit_ip: '',
      });
      expect(signal.details.error).toMatch(/PROXY_NOT_DEDICATED_ISP: requested=direct/);
      expect(signal.details.diagnostics.proxy.requested).toBe('direct');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('redacts URL-form proxy credentials in preflight failure artifacts', () => {
    const rawProxy = 'http://secret-user:secret-pass@proxy.example.test:8001';
    const { cwd, result, signalPath } = runLinkedinRegisterWithProxy(rawProxy);
    try {
      expect(result.status).toBe(3);
      expectNoSessionLaunch(result);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/FAIL: PROXY_NOT_DEDICATED_ISP: url_form_proxy_request/);

      const signalText = readFileSync(signalPath, 'utf8');
      const signal = JSON.parse(signalText);
      expect(signal).toMatchObject({
        action: 'linkedin_register',
        signal: 'proxy_failed',
        healthy: false,
      });
      expect(signal.details.error).toBe('PROXY_NOT_DEDICATED_ISP: url_form_proxy_request');
      expect(signal.details.diagnostics.proxy.requested).toBe('[url-form]');
      expect(signalText).not.toMatch(/secret-user|secret-pass|proxy\.example\.test|user:pass/);
      expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/secret-user|secret-pass|proxy\.example\.test/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
