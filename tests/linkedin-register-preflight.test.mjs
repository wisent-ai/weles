import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

describe('LinkedIn register preflight', () => {
  it('fails invalid proxy requests before browser launch and writes ban_signal', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'linkedin-register-preflight-'));
    try {
      const script = resolve('scripts/trajectories/linkedin_register.mjs');
      const result = spawnSync(process.execPath, [script], {
        cwd,
        env: {
          ...process.env,
          LINKEDIN_REGISTER_PROXY: 'direct',
          WELES_DISABLE_RECORDING: '1',
        },
        encoding: 'utf8',
      });

      expect(result.status).toBe(3);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/FAIL: PROXY_NOT_DEDICATED_ISP: requested=direct/);

      const signalPath = join(cwd, 'recordings', 'linkedin_register', 'ban_signal.json');
      const signal = JSON.parse(readFileSync(signalPath, 'utf8'));
      expect(signal).toMatchObject({
        action: 'linkedin_register',
        signal: 'proxy_failed',
        healthy: false,
      });
      expect(signal.details).toMatchObject({
        final_url: '',
        attempted_email: '',
        expected_exit_ip: '',
      });
      expect(signal.details.error).toMatch(/PROXY_NOT_DEDICATED_ISP: requested=direct/);
      expect(signal.details.diagnostics.proxy.requested).toBe('direct');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
