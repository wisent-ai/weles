// Coverage probes of what the page itself and the session around it showed:
// the page-side access log, console and errors, rendering, WebRTC and input
// hooks, the host, provenance and the recording's sibling files.
import { accessProbe, errorOf, len, present, type Probe } from './read.js';

export const PAGE_PROBES: readonly Probe[] = [
  {
    id: 'A.runtime.page_access_log',
    collector: 'page-side runtime access log',
    expected: 'property reads and wrapped method calls across frames',
    emitted: (_ws, logs) => Boolean(logs.length),
    attempted: (ws) => Boolean(ws._instAccum),
    evidence: (_ws, logs) => [{ field: 'accesses[].log', count: logs.length }],
  },
  {
    id: 'A.runtime.console_errors',
    collector: 'console and page error capture',
    expected: 'Playwright and CDP console/error events',
    emitted: (ws) =>
      Boolean(
        len(ws._instConsole) + len(ws._instPageErrors) + len(ws._instRuntime),
      ),
    attempted: () => true,
    evidence: (ws) => [
      { field: 'console', count: len(ws._instConsole) },
      { field: 'pageerrors', count: len(ws._instPageErrors) },
      { field: 'runtime', count: len(ws._instRuntime) },
    ],
  },
  accessProbe(
    'B.rendering.canvas',
    'canvas pixel hooks',
    'toDataURL/getImageData raw output',
    ['Canvas'],
  ),
  accessProbe(
    'B.rendering.audio',
    'audio output hooks',
    'AudioBuffer and OfflineAudioContext rendered bytes',
    ['AudioBuffer', 'OfflineAudioContext'],
    (ws) => [
      {
        field: 'webaudio',
        count: len(ws._instWebAudio),
        error: errorOf(ws, '_instWebAudioError'),
      },
    ],
  ),
  accessProbe(
    'B.rendering.webgl',
    'WebGL parameter hooks',
    'WebGL/WebGL2 getParameter reads',
    ['WebGL', 'WebGL2'],
  ),
  accessProbe(
    'B.rendering.webgpu',
    'WebGPU adapter hook',
    'requestAdapter info/features/limits',
    ['WebGPU'],
  ),
  {
    id: 'E.host.snapshots',
    collector: 'host snapshot bundle',
    expected:
      'process, network, DNS, power, route, lsof, and platform summaries',
    emitted: (ws) => present(ws._instHostSnapshots),
    attempted: () => true,
    evidence: (ws) => [
      { field: 'host_snapshots', count: len(ws._instHostSnapshots) },
      { field: 'host', present: present(ws._instHost) },
    ],
  },
  {
    id: 'F.provenance.persona_proxy',
    collector: 'persona, proxy, and version provenance',
    expected: 'persona/proxy config and version fields',
    emitted: (ws) =>
      present(ws.personaConfig) ||
      present(ws.proxyConfig) ||
      present(ws._versions),
    attempted: () => true,
    evidence: (ws) => [
      { field: 'persona', present: present(ws.personaConfig) },
      { field: 'proxy', present: present(ws.proxyConfig) },
      { field: 'versions', present: present(ws._versions) },
    ],
  },
  accessProbe(
    'J.webrtc.page_hooks',
    'WebRTC page hooks',
    'SDP, ICE, and getStats observed from page calls',
    ['RTCPeerConnection'],
  ),
  accessProbe(
    'K.trajectory.input_events',
    'input event recorder',
    'pointer, keyboard, wheel, scroll, focus, blur, and value changes',
    ['Input'],
  ),
  {
    id: 'M.artifacts.sibling_manifest',
    collector: 'recording artifact manifest',
    expected: 'sibling screenshots, DOM, video, pcap, netlog, and aux files',
    emitted: (ws) => Boolean(ws._instDir),
    attempted: (ws) => Boolean(ws._instDir),
    evidence: (ws) => [
      {
        field: 'sibling_files_available_at_serialize',
        present: Boolean(ws._instDir),
      },
    ],
  },
];
