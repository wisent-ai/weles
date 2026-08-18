// One-shot patcher: adds `import { checkReachable } from '../../_shared/action-runner.mjs'`
// to the top of each specialized trajectory and inserts `checkReachable(s, '<platform>');`
// after every `await s.goto(...)` line. Idempotent — skips files already patched.
//
// Run: node scripts/lint/patch_reachable.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const FILES = [
  ['discord',   'scripts/trajectories/discord/actions/join_server.mjs'],
  ['discord',   'scripts/trajectories/discord/actions/react.mjs'],
  ['github',    'scripts/trajectories/github/actions/follow.mjs'],
  ['github',    'scripts/trajectories/github/actions/watch_repo.mjs'],
  ['github',    'scripts/trajectories/github/content/commit.mjs'],
  ['github',    'scripts/trajectories/github/content/create_repo.mjs'],
  ['github',    'scripts/trajectories/github/content/fork.mjs'],
  ['github',    'scripts/trajectories/github/content/open_issue.mjs'],
  ['github',    'scripts/trajectories/github/star/run.mjs'],
  ['instagram', 'scripts/trajectories/instagram/actions/follow.mjs'],
  ['instagram', 'scripts/trajectories/instagram/actions/like.mjs'],
  ['instagram', 'scripts/trajectories/instagram/actions/save.mjs'],
  ['instagram', 'scripts/trajectories/instagram/actions/story_view.mjs'],
  ['instagram', 'scripts/trajectories/instagram/content/post.mjs'],
  ['linkedin',  'scripts/trajectories/linkedin/actions/connect.mjs'],
  ['linkedin',  'scripts/trajectories/linkedin/actions/endorse.mjs'],
  ['linkedin',  'scripts/trajectories/linkedin/actions/like.mjs'],
  ['reddit',    'scripts/trajectories/reddit/actions/follow.mjs'],
  ['reddit',    'scripts/trajectories/reddit/actions/join_sub.mjs'],
  ['reddit',    'scripts/trajectories/reddit/actions/upvote.mjs'],
  ['tiktok',    'scripts/trajectories/tiktok/actions/bookmark.mjs'],
  ['tiktok',    'scripts/trajectories/tiktok/actions/follow.mjs'],
  ['tiktok',    'scripts/trajectories/tiktok/actions/like.mjs'],
  ['tiktok',    'scripts/trajectories/tiktok/actions/watch_through.mjs'],
  ['twitter',   'scripts/trajectories/twitter/actions/bookmark.mjs'],
  ['twitter',   'scripts/trajectories/twitter/actions/follow.mjs'],
  ['twitter',   'scripts/trajectories/twitter/actions/like.mjs'],
];

const IMPORT_LINE = "import { checkReachable } from '../../_shared/action-runner.mjs';";

let patched = 0, skipped = 0;
for (const [platform, relPath] of FILES) {
  const path = relPath;
  let src;
  try { src = readFileSync(path, 'utf8'); } catch { console.log(`SKIP missing: ${path}`); continue; }
  if (src.includes('checkReachable')) { skipped++; continue; }

  const lines = src.split('\n');
  let lastImportIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    if (/^import\s.+from\s/.test(lines[i])) lastImportIdx = i;
  }
  if (lastImportIdx === -1) { console.log(`SKIP no imports: ${path}`); continue; }
  lines.splice(lastImportIdx + 1, 0, IMPORT_LINE);

  const out = [];
  for (const line of lines) {
    out.push(line);
    const m = line.match(/^(\s*)await\s+s\.goto\s*\(/);
    if (m) {
      out.push(`${m[1]}checkReachable(s, '${platform}');`);
    }
  }

  // Prefer err.banSignal in catch blocks so checkReachable's structured signal
  // wins. Without this rewrite the catch's bare detectXBanSignals call would
  // overwrite the chrome-error / auth-wall signal with 'healthy'.
  let final = out.join('\n');
  final = final.replace(
    /(} catch \([\w]+\)\s*\n?\s*\{\s*\n\s*ban\s*=\s*)await (detect\w+BanSignals)/g,
    '$1e.banSignal ?? await $2',
  );

  writeFileSync(path, final);
  patched++;
}
console.log(`patched=${patched} skipped=${skipped}`);
