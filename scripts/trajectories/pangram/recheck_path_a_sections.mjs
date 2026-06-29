// Re-run the old Path A Pangram checks with the corrected authenticated checker.
// Uses local Path A source text files only; never touches LSI/NCBR.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';

const ROOT = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent';
const runId = process.env.WELES_RUN_ID || `path-a-pangram-recheck-${new Date().toISOString().replace(/[:.]/g, '-')}`;
process.env.WELES_RUN_ID = runId;

const autoRegister = process.env.AUTO_REGISTER === '1';
const creditBudget = Number(process.env.PANGRAM_CREDIT_BATCH_BUDGET || 3);
const maxItems = Number(process.env.MAX_ITEMS || 999);

const sections = [
  ['1.1', 'Informacje ogólne', 'A_1_1_informacje_ogolne.txt'],
  ['1.2', 'Klasyfikacja', 'A_1_2_klasyfikacja.txt'],
  ['1.3', 'Podmioty', 'A_1_3_podmioty.txt'],
  ['1.4', 'Konkurencja', 'A_1_4_konkurencja.txt'],
  ['1.5', 'Miejsce realizacji', 'A_1_5_miejsce_realizacji.txt'],
  ['2.1', 'Cel', 'sekcja_2_1_cel.txt'],
  ['2.2', 'Innowacyjność', 'sekcja_2_2_innowacyjnosc.txt'],
  ['2.3', 'Rynek', 'sekcja_2_3_rynek.txt'],
  ['2.4', 'Efekty zewnętrzne', 'sekcja_2_4_efekty.txt'],
  ['3.1', 'Sposób wdrożenia', 'sekcja_3_1_sposob.txt'],
  ['3.2', 'Plan wdrożenia', 'sekcja_3_2_plan.txt'],
  ['3.3', 'Opłacalność', 'sekcja_3_3_oplacalnosc.txt'],
  ['3.4', 'Zasoby wdrożeniowe', 'sekcja_3_4_zasoby.txt'],
  ['3.5', 'IP', 'sekcja_3_5_ip.txt'],
  ['4.1', 'Zespół', 'A_4_1_zespol.txt'],
  ['4.2', 'Zasoby techniczne', 'A_4_2_zasoby_techniczne.txt'],
  ['4.3', 'Podwykonawcy', 'A_4_3_podwykonawcy.txt'],
  ['5', 'Premie', 'A_5_premie.txt'],
  ['6', 'Harmonogram', 'A_6_harmonogram.txt'],
  ['7', 'Ryzyka', 'A_7_ryzyka.txt'],
  ['9.1', 'Wskaźniki produktu', 'A_9_1_wskazniki_produktu.txt'],
  ['9.2', 'Wskaźniki rezultatu', 'sekcja_9_2_wskazniki.txt'],
  ['10.1', 'Równość', 'A_10_1_rowność.txt'],
  ['10.2', 'Karta praw', 'A_10_2_karta_praw.txt'],
  ['10.3', 'Niepełnosprawni', 'A_10_3_niepelnosprawni.txt'],
  ['10.4', 'Zrównoważony rozwój', 'sekcja_10_4_zrownowazony.txt'],
].map(([id, title, file]) => ({ id, title, file: join(ROOT, file) }));

function slug(s) {
  return String(s).normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
}

function textStats(text) {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return {
    chars: text.length,
    words,
    estimatedCredits: Math.max(1, Math.ceil(words / 1000)),
    sha256: createHash('sha256').update(text).digest('hex'),
    preview: text.replace(/\s+/g, ' ').trim().slice(0, 120),
  };
}

function runNode(args, env, timeoutMs) {
  return spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

function registerAccount(reportDir, reason) {
  console.error(`[path-a-recheck] registering Pangram account (${reason})`);
  const res = runNode(['scripts/trajectories/pangram/register.mjs'], {
    WELES_RUN_ID: runId,
    ACTION: `pangram_register_${Date.now()}`,
  }, Number(process.env.PANGRAM_REGISTER_TIMEOUT_MS || 180_000));
  const logPath = join(reportDir, `register_${Date.now()}.log`);
  writeFileSync(logPath, `${res.stdout || ''}\n${res.stderr || ''}`.trim());
  if (res.status !== 0) {
    throw new Error(`pangram register failed status=${res.status}; log=${logPath}`);
  }
  return logPath;
}

const reportDir = runRecordingsDir('path_a_pangram_recheck');
mkdirSync(reportDir, { recursive: true });

let usedCredits = creditBudget;
let registerLogs = [];
const results = [];

for (const section of sections.slice(0, maxItems)) {
  if (!existsSync(section.file)) throw new Error(`missing source file: ${section.file}`);
  const text = readFileSync(section.file, 'utf8');
  const st = textStats(text);
  if (autoRegister && usedCredits + st.estimatedCredits > creditBudget) {
    registerLogs.push(registerAccount(reportDir, `next=${section.id}, estimatedCredits=${st.estimatedCredits}`));
    usedCredits = 0;
  }
  usedCredits += st.estimatedCredits;

  const action = `pangram_path_a_${slug(section.id)}_${slug(section.title)}`;
  const resultPath = join(process.cwd(), 'recordings', runId, action, 'pangram_result.json');
  const banPath = join(process.cwd(), 'recordings', runId, action, 'ban_signal.json');
  for (const path of [resultPath, banPath]) if (existsSync(path)) rmSync(path, { force: true });

  console.error(`[path-a-recheck] ${section.id} ${section.title}: words=${st.words} estCredits=${st.estimatedCredits}`);
  const res = runNode(['scripts/trajectories/pangram/analyze_text.mjs'], {
    WELES_RUN_ID: runId,
    ACTION: action,
    PANGRAM_TEXT_FILE: section.file,
    PANGRAM_ANALYZE_TIMEOUT_MS: process.env.PANGRAM_ANALYZE_TIMEOUT_MS || '120000',
  }, Number(process.env.PANGRAM_SECTION_TIMEOUT_MS || 180_000));

  const logPath = join(reportDir, `${slug(section.id)}.pangram.log`);
  writeFileSync(logPath, `${res.stdout || ''}\n${res.stderr || ''}`.trim());
  const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null;
  const banSignal = existsSync(banPath) ? JSON.parse(readFileSync(banPath, 'utf8')) : null;
  const trusted = res.status === 0 && banSignal?.healthy === true && result?.source && result.source !== 'none';
  results.push({
    section_id: section.id,
    title: section.title,
    file: section.file,
    ...st,
    exitCode: res.status,
    signal: res.signal,
    logPath,
    banSignal: banSignal?.signal || null,
    account: banSignal?.username || null,
    trusted,
    verdict: trusted ? result.verdict ?? null : null,
    ai_percent: trusted ? result.ai_percent ?? null : null,
    human_percent: trusted ? result.human_percent ?? null : null,
    source: trusted ? result.source ?? null : null,
    api_kind: trusted ? result.api_kind ?? null : null,
  });
}

const reportPath = join(reportDir, 'report.json');
writeFileSync(reportPath, JSON.stringify({ runId, autoRegister, creditBudget, registerLogs, results }, null, 2));
console.log(JSON.stringify({ runId, reportDir, reportPath, count: results.length, registerCount: registerLogs.length, results }, null, 2));
process.exit(results.some((r) => !r.trusted) ? 2 : 0);
