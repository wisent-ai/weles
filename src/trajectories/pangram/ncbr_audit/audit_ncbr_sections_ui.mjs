// Batch Pangram UI audit for NCBR STEP Path A and Path B section texts.
// Uses pangram/analyze_text.mjs only, with response-body capture disabled.
// Never touches LSI/NCBR and never calls Pangram detection APIs directly.

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COLLECT_ONLY, MAX_CHECKS, MAX_SCAN_CHARS, MIN_CHARS, MIN_WORDS, NO_ACCOUNT, ONLY_PATH, OUT_DIR, PATH_A_PDF,
  REUSE_EXISTING, ROOT, RUN_ID, SECTIONS_DIR, SECTION_PATTERN, TS, accountIds, ensureDirs,
} from './audit_ncbr_sections_ui/settings.mjs';
import { slug, splitLongText, stats } from './audit_ncbr_sections_ui/text.mjs';
import { extractPathA, extractPathB } from './audit_ncbr_sections_ui/sources.mjs';
import { loadExistingUiResults, runPangram, trustedResult } from './audit_ncbr_sections_ui/pangram.mjs';
import { markdownReport } from './audit_ncbr_sections_ui/report.mjs';

ensureDirs();

let items = [...extractPathA(), ...extractPathB()];
items = items.filter((it) => (!ONLY_PATH || it.path === ONLY_PATH) && (!SECTION_PATTERN || SECTION_PATTERN.test(`${it.path} ${it.id} ${it.title}`)));
items.sort((a, b) => `${a.path} ${a.id}`.localeCompare(`${b.path} ${b.id}`, 'pl', { numeric: true }));

const existing = loadExistingUiResults();
const results = [];
let checks = 0;
let accountCursor = 0;

for (const item of items) {
  const st = stats(item.text || '');
  const fullTextFile = join(SECTIONS_DIR, `${slug(item.path)}_${slug(item.id)}_${slug(item.title)}.txt`);
  if (item.text) writeFileSync(fullTextFile, item.text);
  const base = {
    path: item.path,
    id: item.id,
    title: item.title,
    source_file: item.source || null,
    text_file: item.text ? fullTextFile : null,
    part: 1,
    part_count: 1,
    ...st,
  };
  if (item.missing) {
    results.push({ ...base, status: 'missing_source', note: item.note || 'source missing' });
    continue;
  }
  if (st.words < MIN_WORDS || st.chars < MIN_CHARS) {
    results.push({ ...base, status: 'skipped_short', note: `below Pangram minimum ${MIN_WORDS} words / ${MIN_CHARS} chars` });
    continue;
  }
  const chunks = splitLongText(item.text, MAX_SCAN_CHARS);
  for (const chunk of chunks) {
    const chunkStats = stats(chunk.text);
    const partCount = chunks.length;
    const chunkFile = partCount === 1
      ? fullTextFile
      : join(SECTIONS_DIR, `${slug(item.path)}_${slug(item.id)}_${slug(item.title)}_part_${String(chunk.part).padStart(2, '0')}.txt`);
    if (partCount > 1) writeFileSync(chunkFile, chunk.text);
    const chunkBase = {
      ...base,
      text_file: chunkFile,
      part: chunk.part,
      part_count: partCount,
      ...chunkStats,
    };
    if (chunkStats.words < MIN_WORDS || chunkStats.chars < MIN_CHARS) {
      results.push({ ...chunkBase, status: 'skipped_short', note: `split part below Pangram minimum ${MIN_WORDS} words / ${MIN_CHARS} chars` });
      continue;
    }
    const cached = existing.get(chunkStats.sha256);
    if (cached) {
      results.push({
        ...chunkBase,
        status: 'reused',
        reused: true,
        verdict: cached.result.verdict ?? null,
        ai_percent: cached.result.ai_percent ?? null,
        human_percent: cached.result.human_percent ?? null,
        pangram_source: cached.result.source,
        artifact: cached.path,
      });
      continue;
    }
    if (COLLECT_ONLY) {
      results.push({ ...chunkBase, status: 'collected_only' });
      continue;
    }
    if (checks >= MAX_CHECKS) {
      results.push({ ...chunkBase, status: 'pending_max_checks' });
      continue;
    }
    checks += 1;
    const action = `pangram_ncbr_${slug(item.path)}_${slug(item.id)}_p${String(chunk.part).padStart(2, '0')}_${slug(TS)}`;
    let accepted = null;
    const attempts = [];
    const maxAttempts = NO_ACCOUNT ? 1 : Math.max(1, accountIds.length);
    for (let i = 0; i < maxAttempts; i++) {
      const accountId = NO_ACCOUNT ? '' : (accountIds[(accountCursor + i) % accountIds.length] || '');
      console.error(`[audit] ${item.path} ${item.id}${partCount > 1 ? ` part ${chunk.part}/${partCount}` : ''} ${item.title}: attempt ${NO_ACCOUNT ? 'public-ui' : `account=${accountId || 'auto'}`} words=${chunkStats.words}`);
      const run = runPangram({ ...item, part: chunk.part }, chunkFile, action, accountId);
      attempts.push({
        accountId,
        exitCode: run.res.status,
        signal: run.ban?.signal || null,
        healthy: run.ban?.healthy ?? null,
        source: run.result?.source || null,
        verdict: run.result?.verdict || null,
        logPath: run.logPath,
        resultPath: existsSync(run.resultPath) ? run.resultPath : null,
        banPath: existsSync(run.banPath) ? run.banPath : null,
      });
      if (trustedResult(run)) {
        accepted = run;
        if (!NO_ACCOUNT) accountCursor = (accountCursor + i + 1) % Math.max(1, accountIds.length);
        break;
      }
      const signal = run.ban?.signal || '';
      if (!/insufficient_credits|quota_exhausted|checkpoint|no_account|unknown_error|auth_required|captcha_required/i.test(signal)) break;
    }
    if (accepted) {
      results.push({
        ...chunkBase,
        status: 'checked',
        verdict: accepted.result.verdict ?? null,
        ai_percent: accepted.result.ai_percent ?? null,
        human_percent: accepted.result.human_percent ?? null,
        pangram_source: accepted.result.source,
        artifact: accepted.resultPath,
        attempts,
      });
    } else {
      results.push({ ...chunkBase, status: 'failed', attempts });
    }
    const partial = {
      runId: RUN_ID,
      generatedAt: new Date().toISOString(),
      outDir: OUT_DIR,
      results,
    };
    writeFileSync(join(OUT_DIR, 'audit_report.partial.json'), JSON.stringify(partial, null, 2));
  }
}

const report = {
  runId: RUN_ID,
  generatedAt: new Date().toISOString(),
  outDir: OUT_DIR,
  pathA: { pdf: PATH_A_PDF },
  pathB: { root: ROOT, source: 'wersja_B markdown files; no final Path B PDF found locally' },
  minWords: MIN_WORDS,
  minChars: MIN_CHARS,
  collectOnly: COLLECT_ONLY,
  reusedExisting: REUSE_EXISTING,
  checkedCount: results.filter((r) => r.status === 'checked' || r.status === 'reused').length,
  aiGeneratedCount: results.filter((r) => r.verdict === 'ai_generated').length,
  humanCount: results.filter((r) => r.verdict === 'human').length,
  failedCount: results.filter((r) => r.status === 'failed').length,
  skippedCount: results.filter((r) => !['checked', 'reused'].includes(r.status)).length,
  results,
};

writeFileSync(join(OUT_DIR, 'audit_report.json'), JSON.stringify(report, null, 2));
writeFileSync(join(OUT_DIR, 'audit_report.md'), markdownReport(report));
console.log(JSON.stringify({
  runId: RUN_ID,
  outDir: OUT_DIR,
  checkedCount: report.checkedCount,
  humanCount: report.humanCount,
  aiGeneratedCount: report.aiGeneratedCount,
  failedCount: report.failedCount,
  skippedCount: report.skippedCount,
  reportJson: join(OUT_DIR, 'audit_report.json'),
  reportMd: join(OUT_DIR, 'audit_report.md'),
}, null, 2));

process.exit(report.failedCount ? 2 : 0);
