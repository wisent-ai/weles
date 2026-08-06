// Resolve only a checksum-verified, deployment-selected Weles browser release.
// The download scripts install the exact Stado coordinate and write a receipt
// only after the release archive checksum and executable layout are verified.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface BrowserLayout {
  envDir: string;
  envVersion: string;
  envSha256: string;
  installDirName: string;
  product: string;
  asset: string;
  appSubpath: string;
}

const LAYOUTS: Record<string, BrowserLayout> = {
  chromium: {
    envDir: 'WELES_CHROMIUM_DIR',
    envVersion: 'WELES_CHROMIUM_RELEASE_VERSION',
    envSha256: 'WELES_CHROMIUM_RELEASE_SHA256',
    installDirName: 'weles-chromium',
    product: 'weles-chromium',
    asset: 'weles-chromium.tar.gz',
    appSubpath: process.platform === 'darwin'
      ? 'Chromium.app/Contents/MacOS/Chromium'
      : 'chromium/chrome',
  },
  firefox: {
    envDir: 'WELES_FIREFOX_DIR',
    envVersion: 'WELES_FIREFOX_RELEASE_VERSION',
    envSha256: 'WELES_FIREFOX_RELEASE_SHA256',
    installDirName: 'weles-firefox',
    product: 'weles-firefox',
    asset: 'weles-firefox.tar.gz',
    appSubpath: process.platform === 'darwin'
      ? 'Firefox.app/Contents/MacOS/firefox'
      : 'firefox/firefox',
  },
};

const HEX_PAIR_PATTERN = '[a-f\\d][a-f\\d]';
const HEX_QUAD_PATTERN = `${HEX_PAIR_PATTERN}${HEX_PAIR_PATTERN}`;
const HEX_OCTET_PATTERN = `${HEX_QUAD_PATTERN}${HEX_QUAD_PATTERN}`;
const HEX_BLOCK_PATTERN = `${HEX_OCTET_PATTERN}${HEX_OCTET_PATTERN}${HEX_OCTET_PATTERN}${HEX_OCTET_PATTERN}`;
const SHA256_PATTERN = new RegExp(`^${HEX_BLOCK_PATTERN}${HEX_BLOCK_PATTERN}$`);

function releasePlatform(): string | undefined {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'darwin-amd64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-amd64';
  return undefined;
}


function exactReleaseCandidate(browser: string): { binary: string; receipt: string; expectedReceipt: string } | undefined {
  const layout = LAYOUTS[browser];
  const platform = releasePlatform();
  if (!layout || !platform) return undefined;

  const version = process.env[layout.envVersion]?.trim();
  const digest = process.env[layout.envSha256]?.trim().toLowerCase();
  if (!version || !digest || !SHA256_PATTERN.test(digest)) return undefined;

  const home = process.env.HOME ?? '';
  const installRoot = process.env[layout.envDir]?.trim()
    || join(home, '.local/share', layout.installDirName);
  const installDir = join(installRoot, version);
  const releaseUri = `stado://releases/${layout.product}/${version}/${platform}/${layout.asset}`;
  return {
    binary: join(installDir, layout.appSubpath),
    receipt: join(installDir, '.weles-release'),
    expectedReceipt: `release_uri=${releaseUri}\narchive_sha256=${digest}\nplatform=${platform}\n`,
  };
}

/**
 * Find the exact deployment-selected browser only when its verified release
 * receipt matches the requested immutable Stado coordinate and checksum.
 */
export function findCustomBrowser(browser: string = 'chromium'): string | undefined {
  const candidate = exactReleaseCandidate(browser);
  if (!candidate) return undefined;
  try {
    if (!statSync(candidate.binary).isFile()) return undefined;
    return readFileSync(candidate.receipt, 'utf8') === candidate.expectedReceipt
      ? candidate.binary
      : undefined;
  } catch {
    return undefined;
  }
}

export function customBrowserSearchHint(browser: string = 'chromium'): string {
  const layout = LAYOUTS[browser];
  if (!layout) return `unknown browser family "${browser}"`;
  const candidate = exactReleaseCandidate(browser);
  if (!candidate) {
    return `set ${layout.envVersion} and ${layout.envSha256}, then install the exact Stado release with scripts/${browser}/download.sh`;
  }
  return `verified executable not found for the configured release; expected ${candidate.binary} with matching ${candidate.receipt}`;
}

export function findCustomChromium(): string | undefined {
  return findCustomBrowser('chromium');
}
