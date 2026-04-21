// GitHub health probe — lives in github/health/run.mjs because the github/
// top folder already has 5 files at its sibling level (solvers + register).
// Invoke via: node scripts/trajectories/github/health/run.mjs
import { runHealthProbe } from '../../_shared/health-runner.mjs';
import { detectGitHubBanSignals } from '../../../../dist/platforms/github/ban_signals.js';

await runHealthProbe({
  platform: 'github',
  loggedInUrl: 'https://api.github.com/user',
  loggedInRegex: /api\.github\.com\/user$/,
  loggedOutUrl: (u) => `https://api.github.com/users/${encodeURIComponent(u)}`,
  loggedOutRegex: /api\.github\.com\/users\/[^/]+$/,
  banDetector: detectGitHubBanSignals,
  extractLoggedIn: (body) => ({
    ok: !!body?.login && !!body?.id,
    karma: body?.followers ?? null,
    is_suspended: !!body?.suspended_at,
  }),
  extractLoggedOut: (resp) => resp.status === 200 && !!resp.body?.login,
});
