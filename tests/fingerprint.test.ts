import { describe, it, expect } from 'vitest';
import { toConfig, toCppConfig } from '../src/fingerprint.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const fakeFp = {
  fingerprint: {
    navigator: { userAgent: 'Mozilla/5.0 Chrome/135.0.7049.95', hardwareConcurrency: 8, maxTouchPoints: 0 },
    screen: { width: 1920, height: 1080, colorDepth: 24, pixelDepth: 24, devicePixelRatio: 1 },
  },
};

describe('toConfig', () => {
  it('returns correct structure', () => {
    const c = toConfig(fakeFp, 'macos', 'chromium');
    expect(c.browser).toBe('chromium');
    expect(c.navigator.platform).toBe('MacIntel');
    expect(c.navigator.language).toBe('en-US');
    expect(c.screen.width).toBe(1920);
    expect(c.webgl.vendor).toBe('Google Inc.');
  });
  it('uses Windows platform', () => {
    const c = toConfig(fakeFp, 'windows', 'chromium');
    expect(c.navigator.platform).toBe('Win32');
    expect(c.webgl.renderer).toContain('Intel');
  });
  it('uses Linux platform', () => {
    const c = toConfig(fakeFp, 'linux', 'chromium');
    expect(c.navigator.platform).toBe('Linux x86_64');
  });
  it('sets firefox vendor', () => {
    const c = toConfig(fakeFp, 'macos', 'firefox');
    expect(c.webgl.vendor).toBe('Mozilla');
  });
  it('sets chromium-specific nav fields', () => {
    const c = toConfig(fakeFp, 'macos', 'chromium');
    expect(c.navigator.vendor).toBe('Google Inc.');
    expect(c.navigator.productSub).toBe('20030107');
    expect(c.navigator.pdfViewerEnabled).toBe(true);
  });
  it('keeps canvas and audio noise disabled', () => {
    const c = toConfig(fakeFp, 'macos', 'chromium');
    expect(c.canvas).toEqual({});
    expect(c.audio).toEqual({});
  });
});

describe('toCppConfig', () => {
  it('includes clientHints with Google Chrome brand', () => {
    const config = toConfig(fakeFp, 'macos', 'chromium');
    const cpp = toCppConfig(config, 'macos');
    expect(cpp.clientHints).toBeDefined();
    expect(cpp.clientHints.platform).toBe('macOS');
    const brands = cpp.clientHints.brandList;
    expect(brands.some((b: any) => b.brand === 'Google Chrome')).toBe(true);
    expect(brands.some((b: any) => b.brand === 'Chromium')).toBe(true);
  });
  it('maps windows platform version', () => {
    const config = toConfig(fakeFp, 'windows', 'chromium');
    const cpp = toCppConfig(config, 'windows');
    expect(cpp.clientHints.platform).toBe('Windows');
  });
  it('deduplicates language array', () => {
    const config = toConfig(fakeFp, 'macos', 'chromium');
    config.navigator.languages = ['en-US'];
    const cpp = toCppConfig(config, 'macos');
    const langs: string[] = cpp.navigator.languages;
    expect(langs).toContain('en-US');
    expect(langs).toContain('en');
    expect(new Set(langs).size).toBe(langs.length);
  });
  it('preserves canvas and audio seeds', () => {
    const config = toConfig(fakeFp, 'macos', 'chromium');
    const cpp = toCppConfig(config, 'macos');
    expect(cpp.canvas.noiseSeed).toBe(config.canvas.noiseSeed);
    expect(cpp.audio.noiseSeed).toBe(config.audio.noiseSeed);
  });
  it('uses the resolved Chromium app version for client hints', () => {
    const root = mkdtempSync(join(tmpdir(), 'weles-chromium-version-test-'));
    const contents = join(root, 'Chromium.app', 'Contents');
    const executableDir = join(contents, 'MacOS');
    mkdirSync(executableDir, { recursive: true });
    writeFileSync(join(contents, 'Info.plist'), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0">',
      '<dict>',
      '<key>CFBundleShortVersionString</key>',
      '<string>147.0.7727.108</string>',
      '</dict>',
      '</plist>',
    ].join('\n'));

    const chromiumPath = join(executableDir, 'Chromium');
    const config = toConfig(fakeFp, 'macos', 'chromium');
    const cpp = toCppConfig(config, 'macos', { chromiumPath });

    expect(cpp.navigator.userAgent).toContain('Chrome/147.0.0.0');
    expect(cpp.clientHints.fullVersion).toBe('147.0.7727.108');
    expect(cpp.clientHints.brandFullVersionList).toEqual([
      { brand: 'Google Chrome', version: '147.0.7727.108' },
      { brand: 'Not.A/Brand', version: '8.0.0.0' },
      { brand: 'Chromium', version: '147.0.7727.108' },
    ]);
  });
});

describe('toFirefoxWelesPrefs', () => {
  it('emits exact pref names the patched Firefox reads', async () => {
    const { toFirefoxWelesPrefs } = await import('../src/fingerprint.js');
    const cfg = {
      browser: 'firefox',
      navigator: { userAgent: 'Mozilla/5.0 ...', platform: 'MacIntel' },
      screen: { width: 2048, height: 1536, availWidth: 2048, availHeight: 1500, colorDepth: 24, pixelDepth: 24 },
      window: { devicePixelRatio: 2, outerWidth: 2050, outerHeight: 1616, screenX: 42, screenY: 24 },
      webgl: { vendor: 'Apple Inc.', renderer: 'Apple M3', unmaskedVendor: 'Apple Inc. (raw)', unmaskedRenderer: 'Apple M3 (raw)' },
    };
    const prefs = toFirefoxWelesPrefs(cfg as any);
    // Names must match firefox-build/patches/0001-weles-prefs-register.patch
    expect(prefs['weles.fingerprint.webdriver.force']).toBe(true);
    expect(prefs['weles.fingerprint.webgl.vendor']).toBe('Apple Inc. (raw)');
    expect(prefs['weles.fingerprint.webgl.renderer']).toBe('Apple M3 (raw)');
    expect(prefs['weles.fingerprint.screen.width']).toBe(2048);
    expect(prefs['weles.fingerprint.screen.height']).toBe(1536);
    expect(prefs['weles.fingerprint.screen.avail_width']).toBe(2048);
    expect(prefs['weles.fingerprint.screen.avail_height']).toBe(1500);
    expect(prefs['weles.fingerprint.window.outer_width']).toBe(2050);
    expect(prefs['weles.fingerprint.window.outer_height']).toBe(1616);
    expect(prefs['weles.fingerprint.window.screen_x']).toBe(42);
    expect(prefs['weles.fingerprint.window.screen_y']).toBe(24);
  });
  it('produces sentinel values for partial configs', async () => {
    const { toFirefoxWelesPrefs } = await import('../src/fingerprint.js');
    const prefs = toFirefoxWelesPrefs({ browser: 'firefox' } as any);
    expect(prefs['weles.fingerprint.webgl.vendor']).toBe('');
    expect(prefs['weles.fingerprint.screen.width']).toBe(0);
    expect(prefs['weles.fingerprint.window.outer_width']).toBe(0);
  });
});
