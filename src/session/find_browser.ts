// Resolve a locally-installed weles-patched browser binary.
//
// Resolution order (first existing path wins):
//   1. $WELES_CHROMIUM_DIR / $WELES_FIREFOX_DIR (if set)
//      else ~/.local/share/weles-{chromium,firefox}/<version>/...
//      — where scripts/{chromium,firefox}/download.sh installs release tarballs.
//   2. ../chromium-build/src/out/Weles/          (local Chromium build tree)
//      ../firefox-build/obj-weles/dist/          (local Firefox build tree)
//   3. /opt/chromium/*                           /opt/firefox/*
//
// Returns undefined if no binary found — callers decide whether to error
// (chromium requires a custom binary) or fall through to Playwright-managed
// (firefox Phase 1 is acceptable stock + prefs + stubs).

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

interface BrowserLayout {
  envDir: string;
  installDirName: string;
  appSubpaths: string[];
  localBuildSubpath: string;
  optPaths: string[];
}

const LAYOUTS: Record<string, BrowserLayout> = {
  chromium: {
    envDir: 'WELES_CHROMIUM_DIR',
    installDirName: 'weles-chromium',
    appSubpaths: ['Chromium.app/Contents/MacOS/Chromium', 'chromium/chrome'],
    localBuildSubpath: 'chromium-build/src/out/Weles/Chromium.app/Contents/MacOS/Chromium',
    optPaths: ['/opt/chromium/Chromium', '/opt/chromium/chrome'],
  },
  firefox: {
    envDir: 'WELES_FIREFOX_DIR',
    installDirName: 'weles-firefox',
    appSubpaths: ['Firefox.app/Contents/MacOS/firefox', 'firefox/firefox'],
    localBuildSubpath: 'firefox-build/mozilla-central/obj-weles/dist/Nightly.app/Contents/MacOS/firefox',
    optPaths: ['/opt/firefox/firefox'],
  },
};

/**
 * Find a locally-installed weles-patched browser binary. Returns the first
 * existing path (most-recent version from the install root wins) or undefined.
 */
export function findCustomBrowser(browser: string = 'chromium'): string | undefined {
  const layout = LAYOUTS[browser];
  if (!layout) return undefined;
  const home = process.env.HOME ?? '';
  const installRoot = process.env[layout.envDir] ?? join(home, '.local/share', layout.installDirName);
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
  const prebuilt: string[] = [];
  try {
    for (const v of readdirSync(installRoot).sort(newestFirst)) {
      for (const sub of layout.appSubpaths) prebuilt.push(join(installRoot, v, sub));
    }
  } catch { /* install root may not exist yet */ }
  const local = join(home, 'Documents/CodingProjects/Wisent', layout.localBuildSubpath);
  for (const p of [...prebuilt, local, ...layout.optPaths]) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Back-compat wrapper — old callers expect findCustomChromium(). */
export function findCustomChromium(): string | undefined {
  return findCustomBrowser('chromium');
}
