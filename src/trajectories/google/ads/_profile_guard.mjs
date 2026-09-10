import { execFileSync } from 'node:child_process';

function commandLinesMatching(pattern) {
  try {
    return execFileSync('pgrep', ['-fl', pattern], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith(`${process.pid} `));
  } catch {
    return [];
  }
}

export function googleAdsProfileProcesses(userDataDir) {
  const profileNeedle = String(userDataDir || '').trim();
  const matches = new Map();
  for (const line of commandLinesMatching('weles-chromium|Chromium')) {
    if (profileNeedle && !line.includes(profileNeedle)) continue;
    const pid = line.split(/\s+/, 1)[0];
    if (/^\d+$/.test(pid)) matches.set(pid, line);
  }
  return [...matches.values()];
}

export function assertGoogleAdsProfileNotAlreadyOpen(userDataDir, label) {
  if (process.env.GOOGLE_ADS_PROFILE_GUARD === '0') return;
  const processes = googleAdsProfileProcesses(userDataDir);
  if (!processes.length) return;
  const preview = processes
    .map((line) => line.length > 260 ? `${line.slice(0, 260)}...` : line)
    .join('\n');
  throw new Error([
    `[${label}] refusing to launch a new Weles session: Google Ads profile is already open`,
    `profile=${userDataDir}`,
    'Use the existing window via CUA/snapshot instead of starting another Playwright/WSession flow.',
    preview,
  ].join('\n'));
}

export function closeAllowedByEnv(closeRequestedEnvName = 'GOOGLE_ADS_CLOSE_AFTER_HARVEST') {
  return process.env.GOOGLE_ADS_ALLOW_CLOSE_PROFILE === '1' && process.env[closeRequestedEnvName] === '1';
}
