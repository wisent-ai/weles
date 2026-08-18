#!/usr/bin/env node
// Source provenance audit for the shipped Weles Chromium binary.
// Does not launch Chromium and does not touch LinkedIn.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const OUT_DIR = 'recordings/audits';
const RELEASE_TAG = process.env.WELES_CHROMIUM_RELEASE ?? 'chromium-147.0.7727.108-weles.1';
const EXPECTED_BRANCH = process.env.WELES_CHROMIUM_EXPECTED_BRANCH ?? 'weles-147';
const EXPECTED_COMMITS = (process.env.WELES_CHROMIUM_EXPECTED_COMMITS
  ?? '35d835833b5ea,11485e78c5809,2c704e8d6417d').split(',').map((s) => s.trim()).filter(Boolean);
const PROJECTS_ROOT = process.env.PROJECTS_ROOT ?? dirname(process.cwd());
const SKIP_GITHUB = process.env.WELES_SOURCE_PROVENANCE_SKIP_GITHUB === '1';

function run(cmd, args, opts = {}) {
  try {
    return {
      ok: true,
      stdout: execFileSync(cmd, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        cwd: opts.cwd ?? process.cwd(),
      }),
      stderr: '',
    };
  } catch (e) {
    return {
      ok: false,
      stdout: e.stdout?.toString?.() ?? '',
      stderr: e.stderr?.toString?.() ?? e.message ?? String(e),
    };
  }
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function read(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

function git(path, args) {
  return run('git', args, { cwd: path });
}

function shaFile(path) {
  if (!existsSync(path)) return null;
  const cmd = process.platform === 'darwin' ? ['shasum', ['-a', '256', path]] : ['sha256sum', [path]];
  const out = run(cmd[0], cmd[1]).stdout.trim();
  return out.split(/\s+/)[0] || null;
}

function walkDirs(root, maxDepth = 4) {
  const out = [];
  const stack = [{ path: root, depth: 0 }];
  while (stack.length) {
    const item = stack.pop();
    if (!item || item.depth > maxDepth || !existsSync(item.path)) continue;
    let st;
    try { st = statSync(item.path); } catch { continue; }
    if (!st.isDirectory()) continue;
    out.push(item.path);
    let names = [];
    try { names = readdirSync(item.path); } catch { continue; }
    for (const name of names) {
      if (['node_modules', '.cache', 'Library', 'DerivedData', 'recordings'].includes(name)) continue;
      stack.push({ path: join(item.path, name), depth: item.depth + 1 });
    }
  }
  return out;
}

function localCandidates() {
  const explicit = process.env.WELES_CHROMIUM_SOURCE_DIR ? [process.env.WELES_CHROMIUM_SOURCE_DIR] : [];
  const fixed = [
    join(homedir(), 'Documents/CodingProjects/Wisent/chromium-build/src'),
    join(PROJECTS_ROOT, 'chromium-build/src'),
    join(PROJECTS_ROOT, 'chromium/src'),
    join(PROJECTS_ROOT, 'wisent-content-platform/scripts/chromium-arm64'),
    join(PROJECTS_ROOT, 'wisent-weles'),
  ];
  const gitDirs = walkDirs(PROJECTS_ROOT, 2)
    .filter((p) => existsSync(join(p, '.git')) && /chrom|weles|content-platform/i.test(p));
  return [...new Set([...explicit, ...fixed, ...gitDirs].map((p) => resolve(p)))];
}

function inspectGitRepo(path) {
  const isRepo = existsSync(join(path, '.git')) || git(path, ['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';
  if (!isRepo) return null;
  const root = git(path, ['rev-parse', '--show-toplevel']).stdout.trim() || path;
  const remote = git(root, ['remote', '-v']).stdout.trim().split(/\n/).slice(0, 8);
  const head = git(root, ['rev-parse', 'HEAD']).stdout.trim() || null;
  const branch = git(root, ['branch', '--show-current']).stdout.trim() || null;
  const branches = git(root, ['branch', '-a', '--list', `*${EXPECTED_BRANCH}*`]).stdout.trim().split(/\n/).map((s) => s.trim()).filter(Boolean);
  const commitPresence = Object.fromEntries(EXPECTED_COMMITS.map((commit) => {
    const ok = git(root, ['cat-file', '-e', `${commit}^{commit}`]).ok;
    return [commit, ok];
  }));
  const files = [
    'weles-patches.diff',
    'patches/weles_fingerprint_config.cc',
    'patches/weles_fingerprint_config.h',
    'scripts/chromium/README.md',
    'scripts/chromium/download.sh',
  ].map((rel) => ({ rel, exists: existsSync(join(root, rel)) }));
  return {
    path: root,
    name: basename(root),
    head,
    branch,
    remotes: remote,
    expected_branch_refs: branches,
    expected_commits_present: commitPresence,
    expected_commit_count: Object.values(commitPresence).filter(Boolean).length,
    relevant_files: files.filter((f) => f.exists),
  };
}

function inspectPatchDir(path) {
  const diff = join(path, 'weles-patches.diff');
  const config = join(path, 'patches/weles_fingerprint_config.cc');
  if (!existsSync(diff) && !existsSync(config)) return null;
  const text = `${read(diff)}\n${read(config)}\n${read(join(path, 'build.log'))}`;
  return {
    path,
    has_diff: existsSync(diff),
    diff_sha256: shaFile(diff),
    has_config_cc: existsSync(config),
    config_cc_sha256: shaFile(config),
    mentions_expected_branch: text.includes(EXPECTED_BRANCH),
    expected_commit_mentions: Object.fromEntries(EXPECTED_COMMITS.map((commit) => [commit, text.includes(commit)])),
    has_debug_markers: /WELES_DEBUG|weles_debug\.log|weles_brands\.log|\/tmp\/weles_brands\.log/.test(text),
    has_build_errors: /error:|FAILED:|no member named|String::FromUtf8|cfg->webrtc_ip/i.test(text),
  };
}

function releaseInfo() {
  if (SKIP_GITHUB) return { available: false, skipped: true, error: 'github_checks_skipped' };
  const gh = run('gh', ['release', 'view', RELEASE_TAG, '--repo', 'wisent-ai/weles', '--json', 'tagName,name,publishedAt,body,assets']);
  if (!gh.ok) return { available: false, error: gh.stderr.slice(0, 500) };
  const parsed = parseJson(gh.stdout);
  if (!isObject(parsed)) return { available: false, error: 'release_json_parse_failed' };
  const body = String(parsed.body ?? '');
  const sourceUrls = [...body.matchAll(/https:\/\/github\.com\/[^\s)`]+/g)].map((m) => m[0]);
  return {
    available: true,
    tag: parsed.tagName,
    name: parsed.name,
    published_at: parsed.publishedAt,
    body_source_urls: sourceUrls,
    mentions_expected_branch: body.includes(EXPECTED_BRANCH),
    expected_commit_mentions: Object.fromEntries(EXPECTED_COMMITS.map((commit) => [commit, body.includes(commit)])),
    assets: (parsed.assets ?? []).map((a) => ({
      name: a.name,
      size: a.size,
      digest: a.digest ?? null,
      download_count: a.downloadCount ?? null,
    })),
  };
}

function githubOrgEvidence() {
  if (SKIP_GITHUB) {
    return {
      skipped: true,
      repo_list_available: false,
      relevant_repos: [],
      code_searches: [],
    };
  }
  const reposCmd = run('gh', ['repo', 'list', 'wisent-ai', '--limit', '300', '--json', 'name,visibility,updatedAt,url']);
  const repos = reposCmd.ok ? (parseJson(reposCmd.stdout) ?? []) : [];
  const relevantRepos = Array.isArray(repos)
    ? repos.filter((r) => /chrom|weles|content|build/i.test(r.name ?? ''))
    : [];
  const codeSearches = EXPECTED_COMMITS.map((commit) => {
    const out = run('gh', ['search', 'code', `${commit} org:wisent-ai`, '--limit', '20', '--json', 'repository,path']);
    const parsed = out.ok ? parseJson(out.stdout) : null;
    return {
      query: commit,
      ok: out.ok,
      error: out.ok ? null : out.stderr.slice(0, 300),
      hits: Array.isArray(parsed) ? parsed.map((h) => ({
        repo: h.repository?.fullName ?? h.repository?.nameWithOwner ?? null,
        path: h.path ?? null,
      })) : [],
    };
  });
  const branchSearch = run('gh', ['search', 'code', `${EXPECTED_BRANCH} org:wisent-ai`, '--limit', '20', '--json', 'repository,path']);
  return {
    repo_list_available: reposCmd.ok,
    relevant_repos: relevantRepos.map((r) => ({ name: r.name, visibility: r.visibility, updated_at: r.updatedAt, url: r.url })),
    code_searches: [
      ...codeSearches,
      {
        query: EXPECTED_BRANCH,
        ok: branchSearch.ok,
        error: branchSearch.ok ? null : branchSearch.stderr.slice(0, 300),
        hits: Array.isArray(parseJson(branchSearch.stdout)) ? parseJson(branchSearch.stdout).map((h) => ({
          repo: h.repository?.fullName ?? h.repository?.nameWithOwner ?? null,
          path: h.path ?? null,
        })) : [],
      },
    ],
  };
}

const candidates = localCandidates();
const gitRepos = [];
const seenGit = new Set();
const patchDirs = [];
for (const candidate of candidates) {
  const repo = inspectGitRepo(candidate);
  if (repo && !seenGit.has(repo.path)) {
    seenGit.add(repo.path);
    gitRepos.push(repo);
  }
  const patch = inspectPatchDir(candidate);
  if (patch) patchDirs.push(patch);
}

const release = releaseInfo();
const github = githubOrgEvidence();

const sourceMatches = gitRepos.filter((repo) => repo.expected_branch_refs.length || repo.expected_commit_count === EXPECTED_COMMITS.length);
const exactSourceFound = sourceMatches.some((repo) => repo.expected_commit_count === EXPECTED_COMMITS.length);
const blockers = [];
if (!release.available) blockers.push('release_metadata_unavailable');
if (release.available && !release.body_source_urls.length) blockers.push('release_lacks_source_repo_url');
if (!exactSourceFound) blockers.push('expected_commits_not_found_in_local_repos');
if (!github.relevant_repos.some((r) => /chrom/i.test(r.name))) blockers.push('no_chromium_named_repo_visible_in_wisent_ai');
if (!patchDirs.length) blockers.push('no_local_patch_dir_found');
if (patchDirs.some((p) => p.has_debug_markers)) blockers.push('local_patch_material_contains_debug_markers');
if (patchDirs.some((p) => p.has_build_errors)) blockers.push('local_patch_material_contains_build_errors');

const report = {
  generated_at: new Date().toISOString(),
  scope: 'Source provenance for Weles Chromium; does not launch Chromium or touch LinkedIn',
  expected: {
    release_tag: RELEASE_TAG,
    branch: EXPECTED_BRANCH,
    commits: EXPECTED_COMMITS,
  },
  release,
  github,
  local: {
    projects_root: PROJECTS_ROOT,
    candidates_checked: candidates,
    git_repos: gitRepos,
    patch_dirs: patchDirs,
  },
  verdict: {
    exact_source_found: exactSourceFound,
    source_matches: sourceMatches.map((r) => r.path),
    can_call_shipped_binary_source_reviewed: exactSourceFound && blockers.length === 0,
    blockers,
    next_required_evidence: [
      'A source repository URL for the Chromium checkout used to build the release.',
      `A git commit or tag reachable from branch ${EXPECTED_BRANCH}.`,
      `Presence of release-mentioned commits: ${EXPECTED_COMMITS.join(', ')}.`,
      'A clean patch diff matching the shipped binary with debug writes removed.',
      'A rebuilt release whose bundle string scan no longer contains Weles debug/local-path markers.',
    ],
  },
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `chromium_source_provenance_audit_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  outPath,
  exact_source_found: report.verdict.exact_source_found,
  can_call_shipped_binary_source_reviewed: report.verdict.can_call_shipped_binary_source_reviewed,
  blockers: report.verdict.blockers,
  relevant_repos: github.relevant_repos.map((r) => r.name),
  local_patch_dirs: patchDirs.map((p) => p.path),
}, null, 2));
