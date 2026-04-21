import { runHealthProbe } from '../_shared/health-runner.mjs';
import { detectTikTokBanSignals } from '../../../dist/platforms/tiktok/ban_signals.js';

await runHealthProbe({
  platform: 'tiktok',
  loggedInUrl: (u) => `https://www.tiktok.com/api/user/detail/?uniqueId=${encodeURIComponent(u)}`,
  loggedInRegex: /\/api\/user\/detail\//,
  loggedOutUrl: (u) => `https://www.tiktok.com/@${encodeURIComponent(u)}`,
  loggedOutRegex: /tiktok\.com\/@[^/?]+$/,
  banDetector: detectTikTokBanSignals,
  extractLoggedIn: (body) => ({
    ok: !!body?.userInfo?.user?.id,
    karma: body?.userInfo?.stats?.followerCount ?? null,
    is_suspended: !!(body?.userInfo?.user?.isBan || body?.statusCode === 10202),
  }),
  extractLoggedOut: (resp) => resp.status === 200 && typeof resp.body === 'string' && !/banned|account doesn'?t exist/i.test(resp.body),
});
