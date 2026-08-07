import { describe, expect, it, vi } from 'vitest';
import { assertPromotionTransition, ringStateRoot } from '../scripts/release/lib.mjs';

describe('immutable release ring transitions', () => {
  it('requires the same manifest to advance through every ring in order', () => {
    expect(() => assertPromotionTransition(null, 'candidate')).not.toThrow();
    expect(() => assertPromotionTransition({ ring: 'candidate' }, 'development')).not.toThrow();
    expect(() => assertPromotionTransition({ ring: 'development' }, 'canary')).not.toThrow();
    expect(() => assertPromotionTransition({ ring: 'canary' }, 'production')).not.toThrow();
    expect(() => assertPromotionTransition({ ring: 'candidate' }, 'production')).toThrow(
      'production promotion requires the same manifest to be active in canary',
    );
    expect(() => assertPromotionTransition({ ring: 'production' }, 'candidate')).toThrow(
      'manifest already advanced to production; it cannot return to candidate',
    );
  });

  it('permits rollback without changing the forward promotion sequence', () => {
    expect(() => assertPromotionTransition({ ring: 'production' }, 'production', 'rolled_back')).not.toThrow();
  });

  it('isolates ring state by safe host identity', () => {
    expect(ringStateRoot('/state', 'canary', 'stado:gcp-1')).toBe('/state/rings/canary/stado:gcp-1');
    expect(() => ringStateRoot('/state', 'canary', '../other-host')).toThrow('host must be a safe state-path segment');
  });

  it('prevents non-production workers from querying or claiming queue rows', async () => {
    const previousClaimsEnabled = process.env.WELES_CLAIMS_ENABLED;
    const originalFetch = globalThis.fetch;
    process.env.WELES_CLAIMS_ENABLED = '0';
    const fetchMock = vi.fn(() => { throw new Error('queue network access is forbidden'); });
    globalThis.fetch = fetchMock;
    try {
      vi.resetModules();
      const { claimOne } = await import('../src/worker/claim.js');
      await expect(claimOne({ enabled: true, actions: ['*'], wildcard: true })).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      if (previousClaimsEnabled === undefined) delete process.env.WELES_CLAIMS_ENABLED;
      else process.env.WELES_CLAIMS_ENABLED = previousClaimsEnabled;
      vi.resetModules();
    }
  });
});
