#!/usr/bin/env node
// Install an official Chrome-for-Testing browser build for fingerprint parity
// audits. The script creates a neutral `baseline-bin` symlink so follow-up
// commands do not need to embed product-name paths.

import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const MANIFEST_URL = 'https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json';
const requested = process.argv[2] || process.env.BASELINE_BROWSER_VERSION || '147.0.7727.108';
const outRoot = resolve(process.env.BASELINE_BROWSER_OUT || '.work/baseline-browsers');

function platformKey() {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'mac-arm64';
  if (process.platform === 'darwin') return 'mac-x64';
  if (process.platform === 'linux') return 'linux64';
  if (process.platform === 'win32' && process.arch === 'arm64') return 'win64';
  if (process.platform === 'win32') return 'win64';
  throw new Error(`unsupported host platform: ${process.platform}/${process.arch}`);
}

function isExecutable(path) {
  try {
    const st = statSync(path);
    return st.isFile() && (st.mode & 0o111);
  } catch {
    return false;
  }
}

function walk(root, maxDepth = 8) {
  const out = [];
  const stack = [{ path: root, depth: 0 }];
  while (stack.length) {
    const item = stack.pop();
    if (!item || item.depth > maxDepth) continue;
    let st;
    try { st = statSync(item.path); } catch { continue; }
    if (st.isFile()) {
      out.push(item.path);
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const name of readdirSync(item.path)) {
      stack.push({ path: join(item.path, name), depth: item.depth + 1 });
    }
  }
  return out;
}

function pickBinary(root) {
  const files = walk(root);
  const executableFiles = files.filter(isExecutable);
  const preferred = executableFiles.find((path) => /Google Chrome for Testing$/.test(path))
    || executableFiles.find((path) => /Google Chrome$/.test(path))
    || executableFiles.find((path) => /chrome$/.test(path));
  if (!preferred) throw new Error(`no executable browser binary found under ${root}`);
  return preferred;
}

async function download(url, path) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed ${res.status}: ${url}`);
  await pipeline(res.body, createWriteStream(path));
}

async function main() {
  mkdirSync(outRoot, { recursive: true });
  const manifestRes = await fetch(MANIFEST_URL);
  if (!manifestRes.ok) throw new Error(`manifest fetch failed: ${manifestRes.status}`);
  const manifest = await manifestRes.json();
  const versions = Array.isArray(manifest.versions) ? manifest.versions : [];
  const platform = platformKey();
  const exact = versions.find((v) => v.version === requested);
  const selected = exact || versions
    .filter((v) => String(v.version || '').startsWith(`${requested}.`) || String(v.version || '').startsWith(requested))
    .sort((a, b) => String(a.version).localeCompare(String(b.version), undefined, { numeric: true }))
    .at(-1);
  if (!selected) throw new Error(`no baseline browser version found for request=${requested}`);
  const dl = selected.downloads?.chrome?.find((d) => d.platform === platform);
  if (!dl?.url) throw new Error(`no download for version=${selected.version} platform=${platform}`);

  const installDir = join(outRoot, selected.version, platform);
  const zipPath = join(outRoot, `${selected.version}-${platform}.zip`);
  const launcherPath = join(outRoot, selected.version, 'baseline-bin');
  if (!existsSync(installDir) || !walk(installDir).some(isExecutable)) {
    rmSync(installDir, { recursive: true, force: true });
    mkdirSync(dirname(zipPath), { recursive: true });
    console.log(`[baseline-install] downloading version=${selected.version} platform=${platform}`);
    await download(dl.url, zipPath);
    mkdirSync(installDir, { recursive: true });
    if (process.platform === 'darwin') {
      execFileSync('ditto', ['-x', '-k', zipPath, installDir], { stdio: 'inherit' });
    } else {
      execFileSync('unzip', ['-q', zipPath, '-d', installDir], { stdio: 'inherit' });
    }
  }

  const bin = pickBinary(installDir);
  rmSync(launcherPath, { force: true });
  writeFileSync(launcherPath, `#!/bin/sh\nexec ${JSON.stringify(bin)} "$@"\n`);
  chmodSync(launcherPath, 0o755);

  console.log(JSON.stringify({
    version: selected.version,
    platform,
    executable: launcherPath,
    real_executable: bin,
    audit_env: `AUDIT_CHROME_PATH=${launcherPath}`,
  }, null, 2));
}

main().catch((e) => {
  console.error(`[baseline-install] fatal: ${e.message || e}`);
  process.exit(1);
});
