import { describe, expect, it } from 'vitest';
import { buildCaptureCoverage } from '../src/session/wsession-helpers/capture_coverage.js';

function byId(cov: any, id: string): any {
  return cov.collectors.find((c: any) => c.id === id);
}

describe('buildCaptureCoverage', () => {
  it('reports emitted collectors from runtime evidence', () => {
    const ws = {
      personaConfig: { os: 'macos' },
      proxyConfig: { server: 'http://127.0.0.1:8080' },
      _instAccum: new Map([
        ['https://example.test', {
          url: 'https://example.test',
          log: [
            { o: 'Canvas', p: 'toDataURL' },
            { o: 'AudioBuffer', p: 'getChannelData:0' },
            { o: 'WebGL', p: '0x1f00' },
            { o: 'WebGPU', p: 'requestAdapter' },
            { o: 'RTCPeerConnection', p: 'createOffer' },
            { o: 'Input', p: 'click' },
          ],
        }],
      ]),
      _instRequests: [{ phase: 'req' }],
      _instCdpFirehose: [{ domain: 'Page', event: 'loadEventFired' }],
      _instDomSnapshot: { documents: [] },
      _instHeapSnapshot: '{}',
      _instHostSnapshots: { ps: 'ok' },
      _instStorageHistory: [{ state: {} }],
      _instPcap: { enabled: true },
      _instDir: '/tmp/recording',
    };

    const cov = buildCaptureCoverage(ws);
    expect(cov.schema_version).toBe(1);
    expect(byId(cov, 'A.runtime.page_access_log').status).toBe('emitted');
    expect(byId(cov, 'B.rendering.canvas').status).toBe('emitted');
    expect(byId(cov, 'B.rendering.audio').status).toBe('emitted');
    expect(byId(cov, 'B.rendering.webgl').status).toBe('emitted');
    expect(byId(cov, 'B.rendering.webgpu').status).toBe('emitted');
    expect(byId(cov, 'D.network.playwright').status).toBe('emitted');
    expect(byId(cov, 'E.host.snapshots').status).toBe('emitted');
    expect(byId(cov, 'H.storage.state').status).toBe('emitted');
    expect(byId(cov, 'J.webrtc.page_hooks').status).toBe('emitted');
    expect(byId(cov, 'K.trajectory.input_events').status).toBe('emitted');
    expect(byId(cov, 'A.wasm_matrix').status).toBe('missing');
    expect(cov.summary.emitted).toBeGreaterThan(8);
    expect(cov.summary.missing).toBeGreaterThan(0);
  });

  it('reports attempted page collectors when hooks are installed but no page used them', () => {
    const cov = buildCaptureCoverage({ _instAccum: new Map(), _instRequests: [] });

    expect(byId(cov, 'A.runtime.page_access_log').status).toBe('attempted');
    expect(byId(cov, 'D.network.playwright').status).toBe('attempted');
    expect(byId(cov, 'B.rendering.canvas').status).toBe('missing');
  });
});
