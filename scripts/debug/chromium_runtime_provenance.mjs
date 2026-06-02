#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir, platform, release, arch, type } from 'node:os';

const OUT_DIR = 'recordings/audits';
const DEFAULT_RELEASE = process.env.WELES_CHROMIUM_RELEASE ?? 'chromium-147.0.7727.108-weles.1';
const MARKERS = [
  'weles-fingerprint',
  'WELES_DEBUG',
  'weles_debug.log',
  'weles_brands.log',
  '/tmp/weles_brands.log',
  '/Users/lukaszbartoszcze',
  'webrtcIp',
  'webrtc_ip',
];

function cmd(cmdName, args) {
  try {
    return execFileSync(cmdName, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (e) {
    return e.stdout?.toString?.() || e.stderr?.toString?.() || '';
  }
}

function sha256(path) {
  const out = cmd(process.platform === 'darwin' ? 'shasum' : 'sha256sum', process.platform === 'darwin' ? ['-a', '256', path] : [path]);
  return out.trim().split(/\s+/)[0] || null;
}

function appRoot(binary) {
  const marker = '.app/Contents/';
  const idx = binary.indexOf(marker);
  return idx >= 0 ? binary.slice(0, idx + '.app'.length) : dirname(binary);
}

function findInstalledChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.WELES_CHROMIUM_DIR ?? join(homedir(), '.local/share/weles-chromium');
  const candidates = [];
  try {
    for (const version of readdirSync(root).sort().reverse()) {
      candidates.push(join(root, version, 'Chromium.app/Contents/MacOS/Chromium'));
      candidates.push(join(root, version, 'chromium/chrome'));
    }
  } catch {}
  candidates.push(join(homedir(), 'Documents/CodingProjects/Wisent/chromium-build/src/out/Weles/Chromium.app/Contents/MacOS/Chromium'));
  candidates.push('/opt/chromium/Chromium', '/opt/chromium/chrome');
  return candidates.find((p) => existsSync(p)) ?? null;
}

function executableFiles(root) {
  if (!root || !existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let children = [];
    try { children = readdirSync(dir).map((name) => join(dir, name)); } catch { continue; }
    for (const p of children) {
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) stack.push(p);
      else if (st.isFile() && (st.mode & 0o111)) out.push(p);
    }
  }
  return out;
}

function scanStrings(root) {
  const files = executableFiles(root);
  const aggregate = Object.fromEntries(MARKERS.map((m) => [m, false]));
  const hits = [];
  for (const file of files) {
    const strings = cmd('strings', [file]);
    const fileMarkers = {};
    for (const marker of MARKERS) {
      const found = strings.toLowerCase().includes(marker.toLowerCase());
      fileMarkers[marker] = found;
      aggregate[marker] = aggregate[marker] || found;
    }
    const interestingLines = strings
      .split(/\n/)
      .filter((line) => /weles-fingerprint|WELES_DEBUG|weles_debug|weles_brands|webrtcIp|webrtc_ip|\/tmp\/weles|\/Users\/lukaszbartoszcze/i.test(line))
      .slice(0, 80);
    if (Object.values(fileMarkers).some(Boolean) || interestingLines.length) {
      hits.push({ file, markers: fileMarkers, interesting_lines: interestingLines });
    }
  }
  return { executable_file_count: files.length, aggregate, hits };
}

function releaseAssetDigest() {
  if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) return null;
  const asset = process.platform === 'darwin'
    ? 'weles-chromium-147-macos-arm64.tar.gz'
    : 'weles-chromium-147-linux-x86_64.tar.gz';
  const json = cmd('gh', ['release', 'view', DEFAULT_RELEASE, '--repo', 'wisent-ai/weles', '--json', 'assets,tagName,publishedAt']);
  try {
    const parsed = JSON.parse(json);
    const found = parsed.assets?.find((a) => a.name === asset);
    return found ? { release: parsed.tagName, published_at: parsed.publishedAt, asset, digest: found.digest, size: found.size } : null;
  } catch {
    return null;
  }
}

const binary = resolve(process.argv[2] ?? findInstalledChromium() ?? '');
const root = binary ? appRoot(binary) : null;
const exists = !!binary && existsSync(binary);
const stringScan = root ? scanStrings(root) : { executable_file_count: 0, aggregate: {}, hits: [] };
const risky = ['WELES_DEBUG', 'weles_debug.log', 'weles_brands.log', '/tmp/weles_brands.log', '/Users/lukaszbartoszcze']
  .filter((marker) => stringScan.aggregate?.[marker]);

const report = {
  generated_at: new Date().toISOString(),
  host: {
    os_type: type(),
    os_platform: platform(),
    os_release: release(),
    os_arch: arch(),
    node_version: process.version,
    cwd: process.cwd(),
  },
  env: {
    CHROMIUM_PATH: process.env.CHROMIUM_PATH ?? null,
    WELES_CHROMIUM_DIR: process.env.WELES_CHROMIUM_DIR ?? null,
    WELES_CHROMIUM_RELEASE: process.env.WELES_CHROMIUM_RELEASE ?? null,
  },
  binary,
  app_root: root,
  exists,
  binary_sha256: exists ? sha256(binary) : null,
  binary_version: exists ? cmd(binary, ['--version']).trim().slice(0, 300) : null,
  release_asset: releaseAssetDigest(),
  string_scan: stringScan,
  verdict: {
    clean: exists && risky.length === 0,
    risky_markers: risky,
    page_visible: false,
    note: risky.length
      ? 'Native debug markers are in the local Chromium bundle. They are host-side strings, not direct page globals, but the binary should not be treated as clean.'
      : 'No configured risky native markers were found in executable bundle strings.',
  },
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `chromium_runtime_provenance_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ outPath, binary, clean: report.verdict.clean, risky_markers: risky, hit_files: stringScan.hits.map((h) => h.file) }, null, 2));
