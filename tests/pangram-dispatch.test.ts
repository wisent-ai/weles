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
    }, 'pangram_analyze_text', runner);
    expect(env.SVC_TEXT).toBe('sample text');
    expect(env.PANGRAM_TEXT).toBe('override text');
    expect(env.PANGRAM_TEXT_FILE).toBe('/tmp/pangram.txt');
    expect(env.TEXT_FILE).toBe('/tmp/other.txt');
    expect(env.PANGRAM_ANALYZE_URL).toBe('https://www.pangram.com/dashboard');
  });

  it('allows Pangram text analysis without account id', () => {
    const claimSource = readFileSync(new URL('../src/worker/claim.ts', import.meta.url), 'utf8');
    expect(claimSource).toContain("a === 'pangram_analyze_text'");
  });
});
