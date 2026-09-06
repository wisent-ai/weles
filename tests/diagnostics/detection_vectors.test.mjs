import { describe, it, expect } from 'vitest';
import { getDetectionRules } from '../../dist/diagnostics/detection_vectors.js';

function run(ruleId, subject, baseline = {}) {
  const rule = getDetectionRules().find(r => r.id === ruleId);
  if (!rule) throw new Error(`rule ${ruleId} not found`);
  return rule.test(subject, baseline);
}

describe('detection_vectors', () => {
  it('flags navigator.webdriver=true', () => {
    const f = run('nav_webdriver', { js: { navigator: { webdriver: true } } });
    expect(f).not.toBeNull();
    expect(f.severity).toBe('critical');
  });

  it('ignores navigator.webdriver=false', () => {
    const f = run('nav_webdriver', { js: { navigator: { webdriver: false } } });
    expect(f).toBeNull();
  });

  it('flags HeadlessChrome UA', () => {
    const f = run('headless_chrome_ua', { js: { navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36' } } });
    expect(f).not.toBeNull();
    expect(f.severity).toBe('critical');
  });

  it('flags SwiftShader WebGL renderer', () => {
    const f = run('webgl_swiftshader', { js: { webgl1: { params: { UNMASKED_RENDERER: 'Google SwiftShader' } } } });
    expect(f).not.toBeNull();
    expect(f.severity).toBe('critical');
  });

  it('flags WebGL renderer mismatch', () => {
    const s = { js: { webgl1: { params: { UNMASKED_RENDERER: 'ANGLE (NVIDIA)' } } } };
    const b = { js: { webgl1: { params: { UNMASKED_RENDERER: 'ANGLE (Apple)' } } } };
    const f = run('webgl_renderer_mismatch', s, b);
    expect(f).not.toBeNull();
    expect(f.severity).toBe('critical');
  });

  it('flags screen.availTop mismatch', () => {
    const s = { js: { navigator: { userAgent: 'Macintosh' }, screen: { availTop: 0, availLeft: 0 } } };
    const b = { js: { navigator: { userAgent: 'Macintosh' }, screen: { availTop: 30, availLeft: 0 } } };
    const f = run('screen_avail_top', s, b);
    expect(f).not.toBeNull();
    expect(f.severity).toBe('warning');
  });

  it('flags absent performance.now() increments', () => {
    const s = { js: { performance: { nowMinDelta: 0, nowSamples: [1, 1, 1] } } };
    const b = { js: { performance: { nowMinDelta: 5.2 } } };
    const f = run('performance_timing_regular', s, b);
    expect(f).not.toBeNull();
    expect(f.severity).toBe('warning');
  });

  it('ignores performance.now() when baseline is also zero', () => {
    const s = { js: { performance: { nowMinDelta: 0 } } };
    const b = { js: { performance: { nowMinDelta: 0 } } };
    const f = run('performance_timing_regular', s, b);
    expect(f).toBeNull();
  });

  it('flags TLS JA4 mismatch', () => {
    const s = { network: { ja4: 'a' } };
    const b = { network: { ja4: 'b' } };
    const f = run('tls_ja4_mismatch', s, b);
    expect(f).not.toBeNull();
    expect(f.severity).toBe('critical');
  });

  it('flags baseline family mismatch', () => {
    const s = { js: { navigator: { userAgent: 'Windows NT 10.0' } } };
    const b = { js: { navigator: { userAgent: 'Macintosh; Intel Mac OS X 10_15_7' } } };
    const f = run('baseline_family_mismatch', s, b);
    expect(f).not.toBeNull();
    expect(f.severity).toBe('info');
  });

  it('flags WebRTC local IP leak', () => {
    const f = run('webrtc_local_ip_exposed', { js: { webRTC: { localIPs: ['192.168.1.5'] } } });
    expect(f).not.toBeNull();
    expect(f.severity).toBe('warning');
  });

  it('flags missing chrome global', () => {
    const s = { js: { chrome: { exists: false } } };
    const b = { js: { chrome: { exists: true } } };
    const f = run('chrome_global_missing', s, b);
    expect(f).not.toBeNull();
    expect(f.severity).toBe('warning');
  });
});
