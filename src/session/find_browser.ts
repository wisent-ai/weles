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
    // Stado publishes every platform archive of a release as release.tar.gz
    // under the product's coordinate.
    asset: 'release.tar.gz',
    appSubpath:
      process.platform === 'darwin'
        ? 'Chromium.app/Contents/MacOS/Chromium'
        : 'chromium/chrome',
  },
  firefox: {
    envDir: 'WELES_FIREFOX_DIR',
    envVersion: 'WELES_FIREFOX_RELEASE_VERSION',
    envSha256: 'WELES_FIREFOX_RELEASE_SHA256',
    installDirName: 'weles-firefox',
    product: 'weles-firefox',
    asset: 'release.tar.gz',
    appSubpath:
      process.platform === 'darwin'
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
  if (process.platform === 'darwin' && process.arch === 'arm64')
    return 'darwin-arm64';
  if (process.platform === 'darwin' && process.arch === 'x64')
    return 'darwin-amd64';
  if (process.platform === 'linux' && process.arch === 'x64')
    return 'linux-amd64';
  return undefined;
}

function exactReleaseCandidate(browser: string): {
  binary: string;
  receipt: string;
  expectedReceipt: string;
} {
  const layout = LAYOUTS[browser];
  if (!layout) throw new Error(`unknown browser family "${browser}"`);
  const platform = releasePlatform();
  if (!platform) {
    throw new Error(
      `unsupported browser release platform ${process.platform}-${process.arch}`,
    );
  }

  const version = process.env[layout.envVersion]?.trim();
  const digest = process.env[layout.envSha256]?.trim().toLowerCase();
  if (!version) throw new Error(`${layout.envVersion} is not set`);
  if (!digest) throw new Error(`${layout.envSha256} is not set`);
  if (!SHA256_PATTERN.test(digest)) {
    throw new Error(`${layout.envSha256} is not a SHA-256 digest`);
  }
  let installRoot = process.env[layout.envDir]?.trim();
  if (!installRoot) {
    const home = process.env.HOME?.trim();
    if (!home) throw new Error(`${layout.envDir} and HOME are not set`);
    installRoot = join(home, '.local/share', layout.installDirName);
  }
  const installDir = join(installRoot, version);
  const releaseUri = `stado://releases/${layout.product}/${version}/${platform}/${layout.asset}`;
  return {
    binary: join(installDir, layout.appSubpath),
    receipt: join(installDir, '.weles-release'),
    expectedReceipt: `release_uri=${releaseUri}\narchive_sha256=${digest}\nplatform=${platform}\n`,
  };
}

function verifiedBrowser(browser: string): string {
  const candidate = exactReleaseCandidate(browser);
  let isFile: boolean;
  try {
    isFile = statSync(candidate.binary).isFile();
  } catch (error) {
    throw new Error(
      `inspect browser executable ${candidate.binary}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isFile)
    throw new Error(`browser executable is not a file: ${candidate.binary}`);
  let receipt: string;
  try {
    receipt = readFileSync(candidate.receipt, 'utf8');
  } catch (error) {
    throw new Error(
      `read browser release receipt ${candidate.receipt}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (receipt !== candidate.expectedReceipt) {
    throw new Error(
      `browser release receipt ${candidate.receipt} does not match the selected release: expected ${JSON.stringify(candidate.expectedReceipt)}; observed ${JSON.stringify(receipt)}`,
    );
  }
  return candidate.binary;
}

/**
 * Find the exact deployment-selected browser only when its verified release
 * receipt matches the requested immutable Stado coordinate and checksum.
 */
export function findCustomBrowser(
  browser: string = 'chromium',
): string | undefined {
  try {
    return verifiedBrowser(browser);
  } catch {
    return undefined;
  }
}

export function customBrowserSearchHint(browser: string = 'chromium'): string {
  try {
    return `verified browser executable: ${verifiedBrowser(browser)}`;
  } catch (error) {
    return `${error instanceof Error ? error.message : String(error)}; install the exact deployment-selected browser release through Stado`;
  }
}

export function findCustomChromium(): string | undefined {
  return findCustomBrowser('chromium');
}
