import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const helper = resolve('scripts/worker/deploy/gh_release_asset_url.mjs');

function select(selector: string, assets: unknown[]): string {
  const result = spawnSync(process.execPath, [helper, selector], {
    input: JSON.stringify({ assets }),
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  return result.stdout;
}

describe('GitHub release asset selection', () => {
  it('selects the newest immutable vault asset while keeping exact selection for binaries', () => {
    const assets = [
      { name: 'skarbiec.vault.json', url: 'old-exact', updated_at: '2026-07-10T00:00:00Z' },
      { name: `skarbiec.vault.${'a'.repeat(64)}.json`, url: 'new-versioned', updated_at: '2026-07-14T00:00:00Z' },
      { name: 'skarbiec-entitlements-router', url: 'binary', updated_at: '2026-07-01T00:00:00Z' },
    ];

    expect(select('latest-vault:skarbiec.vault.json', assets)).toBe('new-versioned');
    expect(select('skarbiec-entitlements-router', assets)).toBe('binary');
  });
});
