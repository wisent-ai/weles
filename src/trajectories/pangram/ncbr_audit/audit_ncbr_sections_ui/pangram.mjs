// Running one section through the Pangram UI trajectory, reusing an earlier result of the
// same text when there is one, and trusting only a real run.
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOGS_DIR, MIN_CHARS, MIN_WORDS, NO_ACCOUNT, OUT_DIR, REUSE_EXISTING, RUN_ID, WEL } from './settings.mjs';
import { sh, slug } from './text.mjs';

export function walkJson(dir, limit = 20_000) {
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < limit) {
    const cur = stack.pop();
    let entries = [];
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name === 'pangram_result.json') out.push(p);
    }
  }
  return out;
}

export function loadExistingUiResults() {
  const map = new Map();
  if (!REUSE_EXISTING) return map;
  const recordings = join(WEL, 'recordings');
  if (!existsSync(recordings)) return map;
  for (const p of walkJson(recordings)) {
    try {
      const json = JSON.parse(readFileSync(p, 'utf8'));
      const key = json?.input?.sha256;
      if (key && json.source === 'ui' && json.verdict) {
        const prev = map.get(key);
        const mtime = statSync(p).mtimeMs;
        if (!prev || mtime > prev.mtime) map.set(key, { path: p, mtime, result: json });
      }
    } catch {
      // Ignore corrupt or partial files.
    }
  }
  return map;
}

export function resultDirFor(action) {
  return join(WEL, 'recordings', RUN_ID, action);
}

export function runPangram(item, textFile, action, accountId = '') {
  const resultPath = join(resultDirFor(action), 'pangram_result.json');
  const banPath = join(resultDirFor(action), 'ban_signal.json');
  rmSync(resultPath, { force: true });
  rmSync(banPath, { force: true });
  const env = {
    WELES_RUN_ID: RUN_ID,
    ACTION: action,
    PANGRAM_TEXT_FILE: textFile,
    WELES_FORCE_OS: process.env.WELES_FORCE_OS || 'macos',
    WELES_CAPTURE_RESPONSE_BODIES: '0',
    PANGRAM_ANALYZE_TIMEOUT_MS: process.env.PANGRAM_ANALYZE_TIMEOUT_MS || '120000',
    PANGRAM_MIN_WORDS: String(MIN_WORDS),
    PANGRAM_MIN_CHARS: String(MIN_CHARS),
    PANGRAM_ACCOUNT_USAGE_FILE: join(OUT_DIR, 'pangram-account-usage.json'),
    PANGRAM_AUTO_REGISTER: process.env.PANGRAM_AUTO_REGISTER || '0',
    PANGRAM_MAX_AUTO_REGISTERS: process.env.PANGRAM_MAX_AUTO_REGISTERS || '0',
  };
  if (NO_ACCOUNT) {
    env.PANGRAM_NO_ACCOUNT = '1';
    env.PANGRAM_WAIT_FOR_HUMAN_VERIFICATION = process.env.PANGRAM_WAIT_FOR_HUMAN_VERIFICATION || '1';
    env.PANGRAM_HUMAN_VERIFICATION_TIMEOUT_MS = process.env.PANGRAM_HUMAN_VERIFICATION_TIMEOUT_MS || '180000';
  } else {
    env.PANGRAM_REQUIRE_ACCOUNT = '1';
  }
  if (accountId) env.ACCOUNT_ID = accountId;
  const res = sh(process.execPath, ['--env-file=.env', 'src/trajectories/pangram/analyze_text.mjs'], {
    cwd: WEL,
    env,
    timeoutMs: Number(process.env.PANGRAM_SECTION_TIMEOUT_MS || 210_000),
    maxBuffer: 20 * 1024 * 1024,
  });
  const partSuffix = item.part ? `_p${String(item.part).padStart(2, '0')}` : '';
  const logPath = join(LOGS_DIR, `${slug(item.path)}_${slug(item.id)}${partSuffix}_${slug(accountId || 'auto')}.log`);
  writeFileSync(logPath, `${res.stdout || ''}\n${res.stderr || ''}`.trim());
  const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null;
  const ban = existsSync(banPath) ? JSON.parse(readFileSync(banPath, 'utf8')) : null;
  return { res, logPath, resultPath, banPath, result, ban, accountId };
}

export function trustedResult(run) {
  return run.res.status === 0 && run.ban?.healthy === true && run.result?.source === 'ui' && run.result?.verdict;
}
