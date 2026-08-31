import { test } from 'node:test';
import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';

// Every shell script this repository ships must parse. auto-deploy.sh shipped in
// 0.5.40 with a blank line inside a backslash continuation, so line 134 began
// with `&&`. It is the script the release activator runs, under KeepAlive, and
// it died at parse time on every cycle - which meant charless-mac-mini could no
// longer install ANY later release, including the ones fixing it. Nothing ran
// bash over these files, so a one-character edit took the host's whole delivery
// path down silently.
// The runner's cwd is the repository root; `import.meta` would force this file
// to load as ESM, which tap's loader cannot require.
const repoRoot = process.cwd();

function trackedShellScripts(): string[] {
  const listed = execFileSync('git', ['ls-files', '-z', '*.sh'], { cwd: repoRoot, encoding: 'utf8' });
  return listed.split('\0').filter((path) => path.length > 0);
}

test('every tracked shell script parses', () => {
  const scripts = trackedShellScripts();
  assert.ok(scripts.length > 0, 'expected this repository to track shell scripts');
  const broken: string[] = [];
  for (const script of scripts) {
    try {
      execFileSync('bash', ['-n', script], { cwd: repoRoot, stdio: 'pipe' });
    } catch (error: unknown) {
      let detail = String(error);
      if (error && typeof error === 'object' && 'stderr' in error) {
        const stderr = error.stderr;
        if (stderr instanceof Buffer || typeof stderr === 'string') detail = String(stderr).trim();
      }
      broken.push(`${script}: ${detail}`);
    }
  }
  assert.deepEqual(broken, [], `shell scripts that cannot be parsed:\n${broken.join('\n')}`);
});
