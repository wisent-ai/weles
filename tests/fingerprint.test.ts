import { describe, it, expect } from 'vitest';
import { toConfig, toCppConfig } from '../src/fingerprint.js';

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
    expect(c.canvas.noiseSeed).toBeGreaterThan(0);
    expect(c.audio.noiseSeed).toBeGreaterThan(0);
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
    expect(typeof c.navigator.deviceMemory).toBe('number');
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
});
