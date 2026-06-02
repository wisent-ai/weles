#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const OUT_DIR = 'recordings/audits';
const DEFAULT_PATCH_DIR = '../wisent-content-platform/scripts/chromium-arm64';
const DEFAULT_BINARY = `${process.env.HOME}/.local/share/weles-chromium/147.0.7727.108-weles.1/Chromium.app/Contents/MacOS/Chromium`;

function usage() {
  console.error('Usage: node scripts/debug/audit_weles_chromium_patch.mjs [patch-dir] [chromium-binary]');
  process.exit(2);
}

function readIfExists(path) {
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

function commandOk(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    return e.stdout?.toString?.() || e.stderr?.toString?.() || '';
  }
}

function sha256(path) {
  if (!existsSync(path)) return null;
  return commandOk('shasum', ['-a', '256', path]).trim().split(/\s+/)[0] || null;
}

function matchAll(text, rx) {
  return [...text.matchAll(rx)].map((m) => m[1] ?? m[0]);
}

function unique(values) {
  return [...new Set(values)].sort();
}

function optionalFields(headerText) {
  return unique(matchAll(headerText, /std::optional<[^>]+>\s+([a-zA-Z0-9_]+)\s*;/g));
}

function cfgReferences(text) {
  return unique(matchAll(text, /cfg->([a-zA-Z0-9_]+)/g));
}

function diffFiles(text) {
  return unique(matchAll(text, /^\+\+\+ b\/(.+)$/gm).filter((p) => p !== '/dev/null'));
}

function hardcodedPaths(text) {
  return unique(matchAll(text, /"((?:\/Users|\/tmp)\/[^"]+)"/g));
}

function fopenSites(text) {
  const lines = text.split(/\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/\bfopen\s*\(/.test(lines[i])) {
      out.push({ line: i + 1, text: lines[i].slice(0, 240) });
    }
  }
  return out;
}

function buildErrors(text) {
  const lines = text.split(/\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/error:|FAILED:|undefined|no member named|No such file/i.test(lines[i])) {
      out.push({ line: i + 1, text: lines[i].replace(/\x1b\[[0-9;]*m/g, '').slice(0, 300) });
    }
  }
  return out.slice(0, 100);
}

function binaryStrings(binary, patterns) {
  if (!existsSync(binary)) return { exists: false, matches: {} };
  const strings = commandOk('strings', [binary]);
  const matches = {};
  for (const p of patterns) {
    const rx = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    matches[p] = rx.test(strings);
  }
  const versionLines = strings
    .split(/\n/)
    .filter((line) => /147\.0\.7727|weles|Wisent|weles-fingerprint|WELES_DEBUG|weles_brands|weles_debug/i.test(line))
    .slice(0, 200);
  return {
    exists: true,
    sha256: sha256(binary),
    matches,
    version_lines: versionLines,
  };
}

function appBundleRoot(binary) {
  const marker = '.app/Contents/';
  const idx = binary.indexOf(marker);
  if (idx < 0) return dirname(binary);
  return binary.slice(0, idx + '.app'.length);
}

function executableFiles(root) {
  if (!existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let names = [];
    try { names = execFileSync('find', [dir, '-maxdepth', '1', '-mindepth', '1'], { encoding: 'utf8' }).trim().split(/\n/).filter(Boolean); } catch {}
    for (const path of names) {
      let st;
      try { st = statSync(path); } catch { continue; }
      if (st.isDirectory()) {
        stack.push(path);
      } else if (st.isFile() && (st.mode & 0o111)) {
        out.push(path);
      }
    }
  }
  return out;
}

function bundleStringHits(binary, patterns) {
  const root = appBundleRoot(binary);
  const files = executableFiles(root);
  const hits = [];
  const aggregate = Object.fromEntries(patterns.map((p) => [p, false]));
  for (const file of files) {
    const strings = commandOk('strings', [file]);
    const fileHits = {};
    for (const p of patterns) {
      const rx = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const matched = rx.test(strings);
      fileHits[p] = matched;
      aggregate[p] = aggregate[p] || matched;
    }
    const interestingLines = strings
      .split(/\n/)
      .filter((line) => /weles-fingerprint|WELES_DEBUG|weles_debug|weles_brands|webrtcIp|webrtc_ip|\/tmp\/weles|\/Users\/lukaszbartoszcze/i.test(line))
      .slice(0, 120);
    if (Object.values(fileHits).some(Boolean) || interestingLines.length) {
      hits.push({ file, matches: fileHits, interesting_lines: interestingLines });
    }
  }
  return {
    root,
    executable_file_count: files.length,
    aggregate_matches: aggregate,
    hits,
  };
}

const patchDir = resolve(process.argv[2] ?? DEFAULT_PATCH_DIR);
const binary = resolve(process.argv[3] ?? DEFAULT_BINARY);
if (process.argv.includes('--help')) usage();

const diffPath = join(patchDir, 'weles-patches.diff');
const headerPath = join(patchDir, 'patches', 'weles_fingerprint_config.h');
const ccPath = join(patchDir, 'patches', 'weles_fingerprint_config.cc');
const buildLogPath = join(patchDir, 'build.log');
const argsPath = join(patchDir, 'args.gn');
const testConfigPath = join(patchDir, 'test', 'fingerprint.json');

const diff = readIfExists(diffPath);
const header = readIfExists(headerPath);
const cc = readIfExists(ccPath);
const buildLog = readIfExists(buildLogPath);
const args = readIfExists(argsPath);
const testConfigRaw = readIfExists(testConfigPath);

let testConfig = null;
try { testConfig = testConfigRaw ? JSON.parse(testConfigRaw) : null; } catch {}

const headerFields = optionalFields(header);
const diffRefs = cfgReferences(diff);
const ccRefs = cfgReferences(cc);
const missingFromStandaloneHeader = diffRefs.filter((field) => !headerFields.includes(field));
const standaloneFieldsNotReferencedByDiff = headerFields.filter((field) => !diffRefs.includes(field));
const files = diffFiles(diff);
const duplicateFileCounts = files.reduce((acc, file) => {
  acc[file] = (acc[file] ?? 0) + 1;
  return acc;
}, {});

const report = {
  generated_at: new Date().toISOString(),
  patch_dir: patchDir,
  binary,
  files_present: {
    diff: existsSync(diffPath),
    standalone_header: existsSync(headerPath),
    standalone_cc: existsSync(ccPath),
    build_log: existsSync(buildLogPath),
    args_gn: existsSync(argsPath),
    test_config: existsSync(testConfigPath),
  },
  patch_stats: {
    diff_bytes: Buffer.byteLength(diff),
    diff_file_count: files.length,
    duplicated_diff_targets: Object.entries(duplicateFileCounts)
      .filter(([, count]) => count > 1)
      .map(([file, count]) => ({ file, count })),
    touched_files: files,
  },
  config_schema: {
    standalone_header_fields: headerFields,
    standalone_cc_cfg_refs: ccRefs,
    diff_cfg_refs: diffRefs,
    diff_refs_missing_from_standalone_header: missingFromStandaloneHeader,
    standalone_fields_not_referenced_by_diff: standaloneFieldsNotReferencedByDiff,
    test_config_top_level_keys: testConfig ? Object.keys(testConfig).sort() : null,
  },
  suspicious_native_side_effects: {
    fopen_sites: fopenSites(diff),
    hardcoded_paths: hardcodedPaths(diff),
    debug_markers: unique(matchAll(diff, /(WELES_DEBUG|weles_debug|weles_brands|\/tmp\/weles_brands\.log)/g)),
  },
  build: {
    args_gn: args.split(/\n/).filter(Boolean),
    errors: buildErrors(buildLog),
  },
  binary_strings: binaryStrings(binary, [
    'weles-fingerprint',
    'WELES_DEBUG',
    'weles_debug.log',
    'weles_brands.log',
    '/tmp/weles_brands.log',
    'webrtc_ip',
    'webrtcIp',
  ]),
  bundle_strings: bundleStringHits(binary, [
    'weles-fingerprint',
    'WELES_DEBUG',
    'weles_debug.log',
    'weles_brands.log',
    '/tmp/weles_brands.log',
    '/Users/lukaszbartoszcze',
    'webrtc_ip',
    'webrtcIp',
  ]),
  findings: [],
};

if (!existsSync(diffPath)) report.findings.push({ severity: 'high', finding: 'No weles-patches.diff found; native patch source cannot be audited from this checkout.' });
if (missingFromStandaloneHeader.length) report.findings.push({ severity: 'high', finding: 'Patch diff references cfg fields missing from standalone header.', fields: missingFromStandaloneHeader });
if (report.suspicious_native_side_effects.fopen_sites.length) report.findings.push({ severity: 'high', finding: 'Patch diff contains native fopen debug writes.', count: report.suspicious_native_side_effects.fopen_sites.length });
if (report.suspicious_native_side_effects.hardcoded_paths.length) report.findings.push({ severity: 'high', finding: 'Patch diff contains hardcoded local/tmp paths.', paths: report.suspicious_native_side_effects.hardcoded_paths });
if (report.build.errors.length) report.findings.push({ severity: 'high', finding: 'Local build.log contains errors; checked-in patch tree does not prove a successful shipped build.', sample: report.build.errors.slice(0, 10) });
if (report.patch_stats.duplicated_diff_targets.length) report.findings.push({ severity: 'medium', finding: 'Patch diff contains repeated target files, suggesting multiple patch generations in one diff.', targets: report.patch_stats.duplicated_diff_targets.slice(0, 20) });
if (report.binary_strings.exists && report.binary_strings.matches['weles-fingerprint'] !== true) report.findings.push({ severity: 'medium', finding: 'Installed binary strings did not expose weles-fingerprint; this weakens binary/source correlation.' });
if (report.binary_strings.exists && (report.binary_strings.matches['WELES_DEBUG'] || report.binary_strings.matches['weles_debug.log'] || report.binary_strings.matches['weles_brands.log'] || report.binary_strings.matches['/tmp/weles_brands.log'])) report.findings.push({ severity: 'critical', finding: 'Installed binary contains native debug markers from patch diff.' });
if (report.bundle_strings.aggregate_matches['WELES_DEBUG'] || report.bundle_strings.aggregate_matches['weles_debug.log'] || report.bundle_strings.aggregate_matches['weles_brands.log'] || report.bundle_strings.aggregate_matches['/tmp/weles_brands.log'] || report.bundle_strings.aggregate_matches['/Users/lukaszbartoszcze']) {
  report.findings.push({ severity: 'critical', finding: 'Installed Chromium app bundle contains native debug markers or hardcoded local/tmp debug paths.', hits: report.bundle_strings.hits.map((h) => h.file) });
}
if (!report.binary_strings.exists) report.findings.push({ severity: 'medium', finding: 'Installed Chromium binary not found at expected path on this host.' });

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `weles_chromium_patch_audit_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  outPath,
  patchDir,
  binary,
  finding_count: report.findings.length,
  findings: report.findings,
}, null, 2));
