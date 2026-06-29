import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { paramsToEnv, resolveTrajectory } from '../src/worker/dispatch.js';

describe('Pangram trajectory dispatch', () => {
  it('routes Pangram benign trajectories', () => {
    const benignRunner = 'scripts/trajectories/_shared/benign.mjs';
    for (const action of ['pangram_dwell', 'pangram_notifications', 'pangram_search', 'pangram_profile_view']) {
      expect(resolveTrajectory(action)).toBe(benignRunner);
    }
  });

  it('routes Pangram text analysis and maps params', () => {
    const runner = 'scripts/trajectories/pangram/analyze_text.mjs';
    expect(resolveTrajectory('pangram_analyze_text')).toBe(runner);

    const env = paramsToEnv({
      text: 'sample text',
      pangram_text: 'override text',
      pangram_text_file: '/tmp/pangram.txt',
      text_file: '/tmp/other.txt',
      pangram_analyze_url: 'https://www.pangram.com/dashboard',
      pangram_auto_register: true,
      pangram_require_account: '1',
      pangram_max_account_attempts: 12,
      pangram_max_auto_registers: '5',
      pangram_register_after_credit_failures: 3,
    }, 'pangram_analyze_text', runner);
    expect(env.SVC_TEXT).toBe('sample text');
    expect(env.PANGRAM_TEXT).toBe('override text');
    expect(env.PANGRAM_TEXT_FILE).toBe('/tmp/pangram.txt');
    expect(env.TEXT_FILE).toBe('/tmp/other.txt');
    expect(env.PANGRAM_ANALYZE_URL).toBe('https://www.pangram.com/dashboard');
    expect(env.PANGRAM_AUTO_REGISTER).toBe('1');
    expect(env.PANGRAM_REQUIRE_ACCOUNT).toBe('1');
    expect(env.PANGRAM_MAX_ACCOUNT_ATTEMPTS).toBe('12');
    expect(env.PANGRAM_MAX_AUTO_REGISTERS).toBe('5');
    expect(env.PANGRAM_REGISTER_AFTER_CREDIT_FAILURES).toBe('3');
  });

  it('allows Pangram text analysis without account id', () => {
    const claimSource = readFileSync(new URL('../src/worker/claim.ts', import.meta.url), 'utf8');
    expect(claimSource).toContain("a === 'pangram_analyze_text'");
  });

  it('routes the NCBR Pangram audit and maps audit params', () => {
    const runner = 'scripts/trajectories/ncbr/pangram_audit_new_wniosek.mjs';
    expect(resolveTrajectory('ncbr_pangram_audit_new_wniosek')).toBe(runner);

    const env = paramsToEnv({
      ncbr_project_id: 'project-id',
      ncbr_cdp_endpoint: 'http://127.0.0.1:9223',
      section_pattern: '^10\\.',
      min_chars: 400,
      max_sections: '3',
      collect_only: true,
      include_rows: '1',
      pangram_analyze_timeout_ms: 60_000,
      pangram_section_timeout_ms: '120000',
    }, 'ncbr_pangram_audit_new_wniosek', runner);
    expect(env.NCBR_PROJECT_ID).toBe('project-id');
    expect(env.NCBR_CDP_ENDPOINT).toBe('http://127.0.0.1:9223');
    expect(env.SECTION_PATTERN).toBe('^10\\.');
    expect(env.MIN_CHARS).toBe('400');
    expect(env.MAX_SECTIONS).toBe('3');
    expect(env.COLLECT_ONLY).toBe('1');
    expect(env.INCLUDE_ROWS).toBe('1');
    expect(env.PANGRAM_ANALYZE_TIMEOUT_MS).toBe('60000');
    expect(env.PANGRAM_SECTION_TIMEOUT_MS).toBe('120000');

    const claimSource = readFileSync(new URL('../src/worker/claim.ts', import.meta.url), 'utf8');
    expect(claimSource).toContain("a === 'ncbr_pangram_audit_new_wniosek'");
  });
});
