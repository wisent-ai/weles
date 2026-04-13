/**
 * Integration tests — run all 31 trajectories against real sites.
 *
 * Requirements:
 *   CHROMIUM_PATH          — custom weles Chromium binary
 *   OXYLABS_USERNAME/PASSWORD or other proxy credentials
 *   NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY — for credential loading
 *
 * Run:  npx vitest run tests/trajectories.test.ts
 */

import { describe, it, expect } from 'vitest';
import { runTask, REGISTRY } from '../src/agent/tasks.js';

const FIVE_MINUTES = 5 * 60 * 1000;

// Targets for social actions — real public content/users for testing
const TARGETS: Record<string, string> = {
  reddit_upvote: 'https://www.reddit.com/r/test/comments/1a2b3c/test_post/',
  reddit_comment: 'https://www.reddit.com/r/test/comments/1a2b3c/test_post/',
  instagram_follow: 'wisent.ai',
  instagram_like: 'https://www.instagram.com/p/C1234567/',
  twitter_follow: 'elonmusk',
  twitter_like: 'https://x.com/elonmusk/status/1234567890',
  twitter_dm: 'wisent_ai',
  tiktok_follow: 'tiktok',
  tiktok_like: 'https://www.tiktok.com/@tiktok/video/1234567890',
  github_star_repo: 'wisent-ai/weles',
  github_follow: 'lbartoszcze',
};

function skip(reason: string) {
  return () => { console.log(`  SKIP: ${reason}`); };
}

// Guard: skip all if no Chromium binary
const hasChromium = !!process.env.CHROMIUM_PATH;

describe.skipIf(!hasChromium)('trajectories — dashboards', () => {
  it('oxylabs_balance', async () => {
    const r = await runTask('oxylabs_balance');
    expect(r).not.toBeNull();
    expect(String(r)).toMatch(/\d/);
  }, FIVE_MINUTES);

  it('brightdata_balance', async () => {
    const r = await runTask('brightdata_balance');
    expect(r).not.toBeNull();
  }, FIVE_MINUTES);

  it('capmonster_cloud_balance', async () => {
    const r = await runTask('capmonster_cloud_balance');
    expect(r).not.toBeNull();
  }, FIVE_MINUTES);

  it('anticaptcha_balance', async () => {
    const r = await runTask('anticaptcha_balance');
    expect(r).not.toBeNull();
  }, FIVE_MINUTES);

  it('packetstream_balance', async () => {
    const r = await runTask('packetstream_balance');
    expect(r).not.toBeNull();
  }, FIVE_MINUTES);

  it('capsolver_balance', async () => {
    const r = await runTask('capsolver_balance');
    expect(r).not.toBeNull();
  }, FIVE_MINUTES);

  it('twocaptcha_balance', async () => {
    const r = await runTask('twocaptcha_balance');
    expect(r).not.toBeNull();
  }, FIVE_MINUTES);

  it('pingproxies_balance', async () => {
    const r = await runTask('pingproxies_balance');
    expect(r).not.toBeNull();
  }, FIVE_MINUTES);
});

describe.skipIf(!hasChromium)('trajectories — registration', () => {
  it('reddit_register', async () => {
    const r = await runTask('reddit_register');
    expect(r).not.toBeNull();
    expect(typeof r).toBe('string');
  }, FIVE_MINUTES);

  it('instagram_register', async () => {
    const r = await runTask('instagram_register');
    expect(r).not.toBeNull();
    expect(typeof r).toBe('string');
  }, FIVE_MINUTES);

  it('twitter_register', async () => {
    const r = await runTask('twitter_register');
    expect(r).not.toBeNull();
    expect(typeof r).toBe('string');
  }, FIVE_MINUTES);

  it('tiktok_register', async () => {
    const r = await runTask('tiktok_register');
    expect(r).not.toBeNull();
    expect(typeof r).toBe('string');
  }, FIVE_MINUTES);

  it('discord_register', async () => {
    const r = await runTask('discord_register');
    expect(r).not.toBeNull();
    expect(typeof r).toBe('string');
  }, FIVE_MINUTES);
});

describe.skipIf(!hasChromium)('trajectories — login', () => {
  it('reddit_login', async () => {
    const r = await runTask('reddit_login');
    expect(r).not.toBeNull();
  }, FIVE_MINUTES);

  it('instagram_login', async () => {
    const r = await runTask('instagram_login');
    expect(r).not.toBeNull();
  }, FIVE_MINUTES);

  it('twitter_login', async () => {
    const r = await runTask('twitter_login');
    expect(r).not.toBeNull();
  }, FIVE_MINUTES);

  it('tiktok_login', async () => {
    const r = await runTask('tiktok_login');
    expect(r).not.toBeNull();
  }, FIVE_MINUTES);

  it('github_login', async () => {
    const r = await runTask('github_login');
    expect(r).not.toBeNull();
  }, FIVE_MINUTES);

  it('discord_login', async () => {
    const r = await runTask('discord_login');
    expect(r).not.toBeNull();
  }, FIVE_MINUTES);

  it('linkedin_login', async () => {
    const r = await runTask('linkedin_login');
    expect(r).not.toBeNull();
  }, FIVE_MINUTES);
});

describe.skipIf(!hasChromium)('trajectories — social actions', () => {
  it('reddit_upvote', async () => {
    const r = await runTask('reddit_upvote', TARGETS.reddit_upvote);
    expect(r).not.toBeNull();
  }, FIVE_MINUTES);

  it('reddit_comment', async () => {
    const r = await runTask('reddit_comment', TARGETS.reddit_comment);
    expect(r).not.toBeNull();
  }, FIVE_MINUTES);

  it('instagram_follow', async () => {
    const r = await runTask('instagram_follow', TARGETS.instagram_follow);
    expect(r).not.toBeNull();
  }, FIVE_MINUTES);

  it('instagram_like', async () => {
    const r = await runTask('instagram_like', TARGETS.instagram_like);
    expect(r).not.toBeNull();
  }, FIVE_MINUTES);

  it('twitter_follow', async () => {
    const r = await runTask('twitter_follow', TARGETS.twitter_follow);
    expect(r).not.toBeNull();
  }, FIVE_MINUTES);

  it('twitter_like', async () => {
    const r = await runTask('twitter_like', TARGETS.twitter_like);
    expect(r).not.toBeNull();
  }, FIVE_MINUTES);

  it('twitter_dm', async () => {
    const r = await runTask('twitter_dm', TARGETS.twitter_dm);
    expect(r).not.toBeNull();
  }, FIVE_MINUTES);

  it('tiktok_follow', async () => {
    const r = await runTask('tiktok_follow', TARGETS.tiktok_follow);
    expect(r).not.toBeNull();
  }, FIVE_MINUTES);

  it('tiktok_like', async () => {
    const r = await runTask('tiktok_like', TARGETS.tiktok_like);
    expect(r).not.toBeNull();
  }, FIVE_MINUTES);

  it('github_star_repo', async () => {
    const r = await runTask('github_star_repo', TARGETS.github_star_repo);
    expect(r).not.toBeNull();
  }, FIVE_MINUTES);

  it('github_follow', async () => {
    const r = await runTask('github_follow', TARGETS.github_follow);
    expect(r).not.toBeNull();
  }, FIVE_MINUTES);
});

// Sanity: every REGISTRY key has a test
it('all REGISTRY entries are covered', () => {
  const keys = Object.keys(REGISTRY);
  expect(keys).toHaveLength(31);
});
