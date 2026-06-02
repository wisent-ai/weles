// Resolve a locally-installed weles-patched browser binary.
//
// Resolution order (first existing path wins):
//   1. $WELES_CHROMIUM_BIN / $WELES_FIREFOX_BIN (if set)
//   2. $WELES_CHROMIUM_DIR / $WELES_FIREFOX_DIR (if set)
//      else ~/.local/share/weles-{chromium,firefox}/<version>/...
//      — where scripts/{chromium,firefox}/download.sh installs release tarballs.
//   3. ../chromium-build/src/out/Weles/          (local Chromium build tree)
//      ../firefox-build/obj-weles/dist/          (local Firefox build tree)
//   4. /opt/chromium/*                           /opt/firefox/*
//
// Returns undefined if no binary is found; callers decide whether to error.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface BrowserLayout {
  envBins: string[];
  envDir: string;
  installDirName: string;
  appSubpaths: string[];
  appRootSubpaths: string[];
  localBuildSubpath: string;
  optPaths: string[];
}

const LAYOUTS: Record<string, BrowserLayout> = {
  chromium: {
    envBins: ['WELES_CHROMIUM_BIN', 'CHROMIUM_PATH', 'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'],
    envDir: 'WELES_CHROMIUM_DIR',
    installDirName: 'weles-chromium',
    appSubpaths: ['Chromium.app/Contents/MacOS/Chromium', 'chromium/chrome'],
    appRootSubpaths: ['Contents/MacOS/Chromium'],
    localBuildSubpath: 'chromium-build/src/out/Weles/Chromium.app/Contents/MacOS/Chromium',
    optPaths: ['/opt/chromium/Chromium', '/opt/chromium/chrome'],
  },
  firefox: {
    envBins: ['WELES_FIREFOX_BIN', 'FIREFOX_PATH', 'PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH'],
    envDir: 'WELES_FIREFOX_DIR',
    installDirName: 'weles-firefox',
    appSubpaths: ['Firefox.app/Contents/MacOS/firefox', 'firefox/firefox'],
    appRootSubpaths: ['Contents/MacOS/firefox'],
    localBuildSubpath: 'firefox-build/mozilla-central/obj-weles/dist/Nightly.app/Contents/MacOS/firefox',
    optPaths: ['/opt/firefox/firefox'],
  },
};

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function customBrowserCandidates(browser: string = 'chromium'): string[] {
  const layout = LAYOUTS[browser];
  if (!layout) return [];
  const home = process.env.HOME ?? '';
  const installRoot = process.env[layout.envDir] ?? join(home, '.local/share', layout.installDirName);
  const candidates = layout.envBins
    .map((env) => process.env[env]?.trim())
    .filter((path): path is string => Boolean(path));

  // Support both installed-version roots and directly provided app bundles.
  candidates.push(installRoot);
  for (const sub of layout.appSubpaths) candidates.push(join(installRoot, sub));
  for (const sub of layout.appRootSubpaths) candidates.push(join(installRoot, sub));

  // Newest version first. Compare the numeric components (chromium a.b.c.d then
  // the -weles.N suffix) numerically, NOT lexicographically — otherwise
  // "147...-weles.10" would sort before "...-weles.2" and pick an older build.
  const verKey = (s: string): number[] => (s.match(/\d+/g) ?? []).map(Number);
  const newestFirst = (a: string, b: string): number => {
    const ka = verKey(a);
    const kb = verKey(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      const d = (kb[i] ?? 0) - (ka[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };

  try {
    for (const v of readdirSync(installRoot).sort(newestFirst)) {
      for (const sub of layout.appSubpaths) candidates.push(join(installRoot, v, sub));
    }
  } catch { /* install root may not exist yet */ }

  candidates.push(
    join(home, 'Documents/CodingProjects/Wisent', layout.localBuildSubpath),
    ...layout.optPaths,
  );

  return candidates;
}

/**
 * Find a locally-installed weles-patched browser binary. Returns the first
 * existing path (most-recent version from the install root wins) or undefined.
 */
export function findCustomBrowser(browser: string = 'chromium'): string | undefined {
  for (const p of customBrowserCandidates(browser)) if (isFile(p)) return p;
  return undefined;
}

export function customBrowserSearchHint(browser: string = 'chromium'): string {
  const layout = LAYOUTS[browser];
  if (!layout) return `unknown browser family "${browser}"`;
  const envText = [...layout.envBins, layout.envDir].join(' / ');
  const searched = customBrowserCandidates(browser).slice(0, 16).join(', ');
  return `set ${layout.envBins[0]} to the executable or ${layout.envDir} to the install root/app bundle; searched ${envText}: ${searched}`;
}

/** Back-compat wrapper — old callers expect findCustomChromium(). */
export function findCustomChromium(): string | undefined {
  return findCustomBrowser('chromium');
}
