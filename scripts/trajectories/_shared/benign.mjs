/**
 * Universal benign-activity trajectory. One file handles dwell /
 * notifications / search / profile_view across all 7 platforms.
 *
 * Worker invokes with PLATFORM + VERB env vars; the config table below
 * picks the URL, scroll count, and dwell time per (platform, verb) pair.
 * Every run writes recordings/<platform>_<verb>/ban_signal.json via the
 * platform's ban detector so the worker can detect silent bans.
 */
import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { detectRedditBanSignals }    from '../../../dist/platforms/reddit/ban_signals.js';
import { detectTwitterBanSignals }   from '../../../dist/platforms/twitter/ban_signals.js';
import { detectInstagramBanSignals } from '../../../dist/platforms/instagram/ban_signals.js';
import { detectTikTokBanSignals }    from '../../../dist/platforms/tiktok/ban_signals.js';
import { detectLinkedInBanSignals }  from '../../../dist/platforms/linkedin/ban_signals.js';
import { detectDiscordBanSignals }   from '../../../dist/platforms/discord/ban_signals.js';
import { detectGitHubBanSignals }    from '../../../dist/platforms/github/ban_signals.js';
import { detectProductHuntBanSignals } from '../../../dist/platforms/producthunt/ban_signals.js';

const DETECTORS = {
  reddit: detectRedditBanSignals, twitter: detectTwitterBanSignals,
  instagram: detectInstagramBanSignals, tiktok: detectTikTokBanSignals,
  linkedin: detectLinkedInBanSignals, discord: detectDiscordBanSignals,
  github: detectGitHubBanSignals, producthunt: detectProductHuntBanSignals,
};

// Per (platform, verb) config. `url` is the landing URL (static or a function
// of the account's username/search query). `scrolls` is the number of scroll
// ticks. `dwellMs` is the idle read time between scrolls (range picked
// randomly). For verbs without a direct feed (e.g. notifications), url
// points at the specific tab.
const CONFIG = {
  reddit: {
    dwell:         { url: 'https://www.reddit.com/',                          scrolls: 10, dwellMs: [1800, 3500] },
    notifications: { url: 'https://www.reddit.com/notifications/',             scrolls: 3,  dwellMs: [1500, 2500] },
    search:        { url: (_, q) => `https://www.reddit.com/search/?q=${encodeURIComponent(q)}`, scrolls: 6,  dwellMs: [1500, 2500] },
    profile_view:  { url: (u) => `https://www.reddit.com/user/${encodeURIComponent(u)}/`, scrolls: 4, dwellMs: [1500, 2500] },
  },
  twitter: {
    dwell:         { url: 'https://x.com/home',                                scrolls: 10, dwellMs: [2000, 4000] },
    notifications: { url: 'https://x.com/notifications',                       scrolls: 3,  dwellMs: [1500, 2500] },
    search:        { url: (_, q) => `https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query`, scrolls: 6, dwellMs: [1500, 2500] },
    profile_view:  { url: (u) => `https://x.com/${encodeURIComponent(u)}`,      scrolls: 4, dwellMs: [1800, 3500] },
  },
  instagram: {
    dwell:         { url: 'https://www.instagram.com/',                        scrolls: 10, dwellMs: [2000, 4000] },
    notifications: { url: 'https://www.instagram.com/',                        scrolls: 0,  dwellMs: [500, 1500], extra: 'notifications_bell' },
    search:        { url: (_, q) => `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(q)}`, scrolls: 5, dwellMs: [1500, 2500] },
    profile_view:  { url: (u) => `https://www.instagram.com/${encodeURIComponent(u)}/`, scrolls: 5, dwellMs: [1800, 3000] },
  },
  tiktok: {
    dwell:         { url: 'https://www.tiktok.com/foryou',                     scrolls: 14, dwellMs: [3000, 6000] },
    notifications: { url: 'https://www.tiktok.com/messages',                   scrolls: 3,  dwellMs: [1500, 2500] },
    search:        { url: (_, q) => `https://www.tiktok.com/search?q=${encodeURIComponent(q)}`, scrolls: 6, dwellMs: [1800, 3500] },
    profile_view:  { url: (u) => `https://www.tiktok.com/@${encodeURIComponent(u)}`, scrolls: 4, dwellMs: [1500, 2500] },
  },
  linkedin: {
    dwell:         { url: 'https://www.linkedin.com/feed/',                    scrolls: 8,  dwellMs: [2500, 4500] },
    notifications: { url: 'https://www.linkedin.com/notifications/',           scrolls: 3,  dwellMs: [1500, 2500] },
    search:        { url: (_, q) => `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(q)}`, scrolls: 5, dwellMs: [1500, 2500] },
    profile_view:  { url: (u) => `https://www.linkedin.com/in/${encodeURIComponent(u)}/`, scrolls: 4, dwellMs: [1800, 3000] },
  },
  discord: {
    dwell:         { url: 'https://discord.com/channels/@me',                  scrolls: 4,  dwellMs: [2000, 4000] },
    notifications: { url: 'https://discord.com/channels/@me',                  scrolls: 2,  dwellMs: [1500, 2500] },
    search:        { url: 'https://discord.com/channels/@me',                  scrolls: 2,  dwellMs: [1500, 2500] },
    profile_view:  { url: 'https://discord.com/channels/@me',                  scrolls: 2,  dwellMs: [1500, 2500] },
  },
  github: {
    dwell:         { url: 'https://github.com/',                               scrolls: 6,  dwellMs: [2000, 3500] },
    notifications: { url: 'https://github.com/notifications',                  scrolls: 3,  dwellMs: [1500, 2500] },
    search:        { url: (_, q) => `https://github.com/search?q=${encodeURIComponent(q)}&type=repositories`, scrolls: 6, dwellMs: [1500, 2500] },
    profile_view:  { url: (u) => `https://github.com/${encodeURIComponent(u)}`, scrolls: 4, dwellMs: [1500, 2500] },
  },
  producthunt: {
    dwell:         { url: 'https://www.producthunt.com/',                      scrolls: 6,  dwellMs: [2000, 3500] },
    notifications: { url: 'https://www.producthunt.com/notifications',         scrolls: 2,  dwellMs: [1500, 2500] },
    search:        { url: (_, q) => `https://www.producthunt.com/search?q=${encodeURIComponent(q)}`, scrolls: 5, dwellMs: [1500, 2500] },
    profile_view:  { url: (u) => `https://www.producthunt.com/@${encodeURIComponent(u)}`, scrolls: 4, dwellMs: [1500, 2500] },
  },
};

const PLATFORM = process.env.PLATFORM;
const VERB = process.env.VERB;
const QUERY = process.env.SEARCH_QUERY || process.env.QUERY || 'tips';
const TARGET_USER = process.env.TARGET_USER || '';

if (!PLATFORM || !VERB) { console.log('FAIL: PLATFORM and VERB env required'); process.exit(1); }
const platformCfg = CONFIG[PLATFORM];
if (!platformCfg) { console.log(`FAIL: no config for platform=${PLATFORM}`); process.exit(1); }
const verbCfg = platformCfg[VERB];
if (!verbCfg) { console.log(`FAIL: no config for ${PLATFORM}.${VERB}`); process.exit(1); }
const detector = DETECTORS[PLATFORM];
if (!detector) { console.log(`FAIL: no ban detector for ${PLATFORM}`); process.exit(1); }

const acct = await getSocialAccount(PLATFORM);
if (!acct) { console.log(`FAIL: no active ${PLATFORM} account`); process.exit(1); }

const selfHandle = acct.username;
const targetUser = TARGET_USER || selfHandle;
const url = typeof verbCfg.url === 'function' ? verbCfg.url(targetUser, QUERY) : verbCfg.url;

console.log(`[benign] ${PLATFORM}/${VERB} acct=${acct.username} url=${url}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const label = `${PLATFORM}_${VERB}`;
const s = await WSession.start({ label, proxy: proxyUrl, persona });
let banSignal = null;
try {
  await s.goto(url);
  const [minMs, maxMs] = verbCfg.dwellMs;
  for (let i = 0; i < verbCfg.scrolls; i++) {
    await s.page.evaluate(() => window.scrollBy(0, window.innerHeight * (0.5 + Math.random() * 0.7)));
    await s.page.waitForTimeout(minMs + Math.floor(Math.random() * (maxMs - minMs)));
  }
  // If no scrolls requested (e.g. Instagram notifications — click the bell instead)
  if (verbCfg.scrolls === 0) {
    await s.page.waitForTimeout(minMs + Math.floor(Math.random() * (maxMs - minMs)));
  }
  banSignal = await detector(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${banSignal?.signal}`);
  console.log(`PASS: ${PLATFORM}_${VERB} ${verbCfg.scrolls}x scrolls`);
} catch (e) {
  banSignal = await detector(s.page, s.capturedResponses).catch(() => null);
  if (banSignal) console.log(`[ban-signal] ${banSignal.signal}`);
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exitCode = 1;
} finally {
  if (banSignal) {
    try {
      const dir = join(process.cwd(), 'recordings', label);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: label, ...banSignal, ts: new Date().toISOString() }, null, 2));
    } catch (e) { console.log('[ban-signal] persist err:', e.message); }
  }
  await s.close();
}
