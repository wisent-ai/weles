#!/usr/bin/env node
// Checks whether this host can run a valid real Chrome 147 vs Weles 147 audit.
// Does not launch a browser session and does not touch LinkedIn.

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform, arch, release } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const OUT_DIR = 'recordings/audits';
const EXPECT_CHROME_MAJOR = process.env.AUDIT_EXPECT_CHROME_MAJOR ?? '147';
const EXPECT_WELES_MAJOR = process.env.AUDIT_EXPECT_WELES_MAJOR ?? '147';
const explicitChrome = process.env.AUDIT_CHROME_PATH ?? '';
const explicitWeles = process.env.CHROMIUM_PATH ?? '';

function runVersion(path) {
  if (!path || !existsSync(path)) return { path, exists: false, version: null, error: path ? 'missing' : 'not_configured' };
  try {
    const version = execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return { path, exists: true, version, major: parseMajor(version), error: null };
  } catch (e) {
    return { path, exists: true, version: null, major: null, error: String(e.stderr?.toString?.() || e.message || e).slice(0, 300) };
  }
}

function parseMajor(version) {
  const m = String(version ?? '').match(/(?:Chrome|Chromium)\s+(\d+)\./i) || String(version ?? '').match(/(\d+)\./);
  return m ? m[1] : null;
}

function redactProxy(raw) {
  if (!raw || raw === 'direct') return raw || 'direct';
  try {
    const url = new URL(raw);
    const hasAuth = Boolean(url.username || url.password);
    url.username = hasAuth ? '<user>' : '';
    url.password = hasAuth ? '<pass>' : '';
    return url.toString();
  } catch {
    return '[unparseable-proxy]';
  }
}

function proxySignature(raw, username = '', password = '') {
  if (!raw || raw === 'direct') return 'direct';
  try {
    const url = new URL(raw);
    const user = url.username || username;
    const pass = url.password || password;
    return `${url.protocol}//${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}:auth=${Boolean(user || pass)}`;
  } catch {
    return `unparseable:${raw.length}`;
  }
}

function executableCandidates() {
  const chrome = [];
  if (explicitChrome) chrome.push(explicitChrome);
  if (platform() === 'darwin') {
    chrome.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    chrome.push('/Applications/Google Chrome 147.app/Contents/MacOS/Google Chrome');
    chrome.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  }
  const weles = [];
  if (explicitWeles) weles.push(explicitWeles);
  const root = join(homedir(), '.local/share/weles-chromium');
  try {
    for (const version of readdirSync(root).sort().reverse()) {
      weles.push(join(root, version, 'Chromium.app/Contents/MacOS/Chromium'));
      weles.push(join(root, version, 'chromium/chrome'));
    }
  } catch {}
  return {
    chrome: [...new Set(chrome)],
    weles: [...new Set(weles)],
  };
}

function fileMeta(path) {
  try {
    const st = statSync(path);
    return { size: st.size, mtime: new Date(st.mtimeMs).toISOString() };
  } catch {
    return null;
  }
}

function proxyConfiguredSame() {
  const chromeProxy = process.env.AUDIT_PROXY_URL ?? process.env.AUDIT_PROXY_SERVER ?? '';
  const welesProxy = process.env.PROBE_PROXY ?? process.env.LINKEDIN_REGISTER_PROXY ?? process.env.WELES_LINKEDIN_PROXY ?? process.env.PROXY_URL ?? '';
  const chromeSig = proxySignature(chromeProxy, process.env.AUDIT_PROXY_USERNAME, process.env.AUDIT_PROXY_PASSWORD);
  const welesSig = proxySignature(welesProxy);
  return {
    chrome_proxy_configured: !!chromeProxy,
    weles_proxy_configured: !!welesProxy,
    same_proxy_env: !!chromeProxy && !!welesProxy && chromeSig === welesSig,
    chrome_proxy_source: process.env.AUDIT_PROXY_URL ? 'AUDIT_PROXY_URL' : chromeProxy ? 'AUDIT_PROXY_SERVER' : null,
    weles_proxy_source: process.env.PROBE_PROXY ? 'PROBE_PROXY'
      : process.env.LINKEDIN_REGISTER_PROXY ? 'LINKEDIN_REGISTER_PROXY'
        : process.env.WELES_LINKEDIN_PROXY ? 'WELES_LINKEDIN_PROXY'
          : process.env.PROXY_URL ? 'PROXY_URL'
            : null,
    chrome_proxy_redacted: redactProxy(chromeProxy),
    weles_proxy_redacted: redactProxy(welesProxy),
  };
}

const candidates = executableCandidates();
const chromeVersions = candidates.chrome.map(runVersion).map((v) => ({ ...v, meta: fileMeta(v.path) }));
const welesVersions = candidates.weles.map(runVersion).map((v) => ({ ...v, meta: fileMeta(v.path) }));
const selectedChrome = chromeVersions.find((v) => v.major === EXPECT_CHROME_MAJOR) ?? chromeVersions.find((v) => v.exists) ?? null;
const selectedWeles = welesVersions.find((v) => v.major === EXPECT_WELES_MAJOR) ?? welesVersions.find((v) => v.exists) ?? null;
const proxy = proxyConfiguredSame();
const envPins = {
  WELES_CLIENT_HINTS_PLATFORM_VERSION: process.env.WELES_CLIENT_HINTS_PLATFORM_VERSION ?? null,
  WELES_MAC_PLATFORM_VERSION: process.env.WELES_MAC_PLATFORM_VERSION ?? null,
  WELES_CLIENT_HINTS_ARCHITECTURE: process.env.WELES_CLIENT_HINTS_ARCHITECTURE ?? null,
  LINKEDIN_PROXY_COUNTRY: process.env.LINKEDIN_PROXY_COUNTRY ?? null,
  WELES_PROXY_COUNTRY: process.env.WELES_PROXY_COUNTRY ?? null,
  WELES_EXPECTED_TIMEZONE: process.env.WELES_EXPECTED_TIMEZONE ?? null,
  WELES_EXPECTED_LANGUAGE: process.env.WELES_EXPECTED_LANGUAGE ?? null,
};

const checks = [
  {
    id: 'explicit_chrome_path',
    ok: !!explicitChrome,
    detail: explicitChrome || 'AUDIT_CHROME_PATH not set; channel/default Chrome is not enough for valid baseline proof',
  },
  {
    id: 'chrome_147_available',
    ok: chromeVersions.some((v) => v.major === EXPECT_CHROME_MAJOR),
    expected: EXPECT_CHROME_MAJOR,
    observed: chromeVersions.filter((v) => v.exists).map((v) => ({ path: v.path, version: v.version, major: v.major })),
  },
  {
    id: 'weles_147_available',
    ok: welesVersions.some((v) => v.major === EXPECT_WELES_MAJOR),
    expected: EXPECT_WELES_MAJOR,
    observed: welesVersions.filter((v) => v.exists).map((v) => ({ path: v.path, version: v.version, major: v.major })),
  },
  {
    id: 'same_major_available',
    ok: !!selectedChrome?.major && !!selectedWeles?.major && selectedChrome.major === selectedWeles.major,
    chrome_major: selectedChrome?.major ?? null,
    weles_major: selectedWeles?.major ?? null,
  },
  {
    id: 'same_proxy_configured',
    ok: proxy.same_proxy_env,
    detail: proxy,
  },
  {
    id: 'persona_geo_pins_present',
    ok: !!((envPins.LINKEDIN_PROXY_COUNTRY || envPins.WELES_PROXY_COUNTRY) && envPins.WELES_EXPECTED_TIMEZONE && envPins.WELES_EXPECTED_LANGUAGE),
    detail: envPins,
  },
  {
    id: 'mac_platform_version_pin_present',
    ok: !!(envPins.WELES_CLIENT_HINTS_PLATFORM_VERSION || envPins.WELES_MAC_PLATFORM_VERSION),
    detail: 'Pin macOS client hints platformVersion for same-persona baseline if production uses macOS persona.',
  },
];

const report = {
  generated_at: new Date().toISOString(),
  scope: 'Real Chrome 147 vs Weles 147 baseline readiness; no browser session launch and no LinkedIn navigation',
  host: { platform: platform(), arch: arch(), release: release(), node: process.version },
  expected: { chrome_major: EXPECT_CHROME_MAJOR, weles_major: EXPECT_WELES_MAJOR },
  selected: {
    chrome: selectedChrome,
    weles: selectedWeles,
  },
  candidates: {
    chrome: chromeVersions,
    weles: welesVersions,
  },
  env: {
    explicit_chrome_path: explicitChrome || null,
    explicit_weles_path: explicitWeles || null,
    proxy,
    pins: envPins,
  },
  checks,
  ready_for_valid_linkedin_baseline: checks.every((c) => c.ok),
  blockers: checks.filter((c) => !c.ok).map((c) => c.id),
  next_command: checks.every((c) => c.ok)
    ? 'AUDIT_CHROME_PATH="$AUDIT_CHROME_PATH" AUDIT_EXPECT_CHROME_MAJOR=147 AUDIT_EXPECT_WELES_MAJOR=147 AUDIT_PROXY_URL="$LINKEDIN_REGISTER_PROXY" PROBE_PROXY="$LINKEDIN_REGISTER_PROXY" node scripts/debug/audit_chrome_vs_weles.mjs'
    : null,
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `chrome_baseline_readiness_audit_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  outPath,
  ready_for_valid_linkedin_baseline: report.ready_for_valid_linkedin_baseline,
  blockers: report.blockers,
  selected: {
    chrome: selectedChrome ? { path: selectedChrome.path, version: selectedChrome.version, major: selectedChrome.major } : null,
    weles: selectedWeles ? { path: selectedWeles.path, version: selectedWeles.version, major: selectedWeles.major } : null,
  },
  next_command: report.next_command,
}, null, 2));
