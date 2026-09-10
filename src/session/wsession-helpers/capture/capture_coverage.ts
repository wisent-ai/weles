type CoverageStatus = 'emitted' | 'attempted' | 'missing';

interface Evidence {
  field: string;
  count?: number;
  present?: boolean;
  error?: string | null;
}

interface CollectorCoverage {
  id: string;
  section: string;
  collector: string;
  expected: string;
  status: CoverageStatus;
  evidence: Evidence[];
}

function len(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === 'object') return Object.keys(v).length;
  return 0;
}

function present(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  return v !== null && v !== undefined;
}

function errorOf(ws: any, key: string): string | null {
  const v = ws?.[key];
  return v ? String(v).slice(0, 240) : null;
}

function allAccessLogs(ws: any): any[] {
  const out: any[] = [];
  try {
    for (const frame of ws?._instAccum?.values?.() ?? []) {
      if (Array.isArray(frame?.log)) out.push(...frame.log);
    }
  } catch {}
  return out;
}

function countAccess(logs: any[], obj: string, propPrefix?: string): number {
  return logs.filter((x) => x?.o === obj && (!propPrefix || String(x?.p ?? '').startsWith(propPrefix))).length;
}

function status(hasData: boolean, wasAttempted: boolean): CoverageStatus {
  if (hasData) return 'emitted';
  return wasAttempted ? 'attempted' : 'missing';
}

export function buildCaptureCoverage(ws: any): any {
  const logs = allAccessLogs(ws);
  const collectors: CollectorCoverage[] = [];
  const add = (id: string, section: string, collector: string, expected: string, s: CoverageStatus, evidence: Evidence[]) => {
    collectors.push({ id, section, collector, expected, status: s, evidence });
  };

  const accessCount = logs.length;
  add('A.runtime.page_access_log', 'A', 'page-side runtime access log', 'property reads and wrapped method calls across frames', status(accessCount > 0, !!ws?._instAccum), [
    { field: 'accesses[].log', count: accessCount },
  ]);
  add('A.runtime.console_errors', 'A', 'console and page error capture', 'Playwright and CDP console/error events', status(len(ws?._instConsole) + len(ws?._instPageErrors) + len(ws?._instRuntime) > 0, true), [
    { field: 'console', count: len(ws?._instConsole) },
    { field: 'pageerrors', count: len(ws?._instPageErrors) },
    { field: 'runtime', count: len(ws?._instRuntime) },
  ]);

  const canvasCount = countAccess(logs, 'Canvas');
  add('B.rendering.canvas', 'B', 'canvas pixel hooks', 'toDataURL/getImageData raw output', status(canvasCount > 0, accessCount > 0), [
    { field: 'accesses.Canvas', count: canvasCount },
  ]);
  const audioCount = countAccess(logs, 'AudioBuffer') + countAccess(logs, 'OfflineAudioContext');
  add('B.rendering.audio', 'B', 'audio output hooks', 'AudioBuffer and OfflineAudioContext rendered bytes', status(audioCount > 0, accessCount > 0), [
    { field: 'accesses.AudioBuffer+OfflineAudioContext', count: audioCount },
    { field: 'webaudio', count: len(ws?._instWebAudio), error: errorOf(ws, '_instWebAudioError') },
  ]);
  const glCount = countAccess(logs, 'WebGL') + countAccess(logs, 'WebGL2');
  add('B.rendering.webgl', 'B', 'WebGL parameter hooks', 'WebGL/WebGL2 getParameter reads', status(glCount > 0, accessCount > 0), [
    { field: 'accesses.WebGL+WebGL2', count: glCount },
  ]);
  const gpuCount = countAccess(logs, 'WebGPU');
  add('B.rendering.webgpu', 'B', 'WebGPU adapter hook', 'requestAdapter info/features/limits', status(gpuCount > 0, accessCount > 0), [
    { field: 'accesses.WebGPU', count: gpuCount },
  ]);

  const cdpAny = len(ws?._instCdpFirehose) + len(ws?._instTargetEvents) + len(ws?._instFrameEvents);
  add('C.cdp.firehose', 'C', 'CDP event firehose', 'subscribed CDP events with overflow accounting', status(cdpAny > 0, !!ws?._cdp), [
    { field: 'cdp_firehose', count: len(ws?._instCdpFirehose) },
    { field: 'cdp_firehose_overflow', count: Number(ws?._instCdpFirehoseOverflow ?? 0) },
  ]);
  add('C.cdp.final_snapshots', 'C', 'final CDP snapshots', 'DOMSnapshot, pierced DOM, heap snapshot, browser/process state', status(present(ws?._instDomSnapshot) || present(ws?._instHeapSnapshot), !!ws?._cdp), [
    { field: 'dom_snapshot', present: present(ws?._instDomSnapshot), error: errorOf(ws, '_instDomSnapshotError') },
    { field: 'dom_pierced_tree', present: present(ws?._instDomPiercedTree), error: errorOf(ws, '_instDomPiercedTreeError') },
    { field: 'heap_snapshot', present: present(ws?._instHeapSnapshot), error: errorOf(ws, '_instHeapSnapshotError') },
    { field: 'system_info', present: present(ws?._instSystemInfo) },
  ]);
  add('C.cdp.metrics_tracing_coverage', 'C', 'metrics, tracing, and coverage', 'Performance/Memory polling, Tracing, JS/CSS coverage', status(len(ws?._instMetricsHistory) + len(ws?._instTracing) > 0 || present(ws?._instJsCoverageData), !!ws?._cdp), [
    { field: 'cdp_metrics', count: len(ws?._instMetricsHistory) },
    { field: 'cdp_tracing', count: len(ws?._instTracing), error: errorOf(ws, '_instTracingError') },
    { field: 'js_coverage', present: present(ws?._instJsCoverageData), error: errorOf(ws, '_instJsCoverageError') },
    { field: 'css_coverage', present: present(ws?._instCssCoverageData), error: errorOf(ws, '_instCssCoverageError') },
  ]);

  add('D.network.playwright', 'D', 'Playwright network/body capture', 'requests, responses, failures, bodies, WebSocket frames', status(len(ws?._instRequests) > 0, !!ws?._instRequests), [
    { field: 'requests', count: len(ws?._instRequests) },
  ]);
  add('D.network.cdp_extra', 'D', 'CDP network extra-info', 'wire headers, cookie blocking, cache, WebSocket handshake events', status(len(ws?._instCdpNetwork) > 0, !!ws?._cdp), [
    { field: 'cdp_network', count: len(ws?._instCdpNetwork) },
  ]);
  add('D.network.pcap', 'D', 'pcap sidecar', 'tcpdump pcap plus SSLKEYLOGFILE path/status', status(!!ws?._instPcap?.enabled && !ws?._instPcap?.spawn_error, !!ws?._instPcap), [
    { field: 'pcap.enabled', present: !!ws?._instPcap?.enabled, error: ws?._instPcap?.spawn_error ?? null },
  ]);

  add('E.host.snapshots', 'E', 'host snapshot bundle', 'process, network, DNS, power, route, lsof, and platform summaries', status(present(ws?._instHostSnapshots), true), [
    { field: 'host_snapshots', count: len(ws?._instHostSnapshots) },
    { field: 'host', present: present(ws?._instHost) },
  ]);
  add('F.provenance.persona_proxy', 'F', 'persona, proxy, and version provenance', 'persona/proxy config and version fields', status(present(ws?.personaConfig) || present(ws?.proxyConfig) || present(ws?._versions), true), [
    { field: 'persona', present: present(ws?.personaConfig) },
    { field: 'proxy', present: present(ws?.proxyConfig) },
    { field: 'versions', present: present(ws?._versions) },
  ]);
  add('H.storage.state', 'H', 'browser storage state', 'context storage snapshots and storage events', status(len(ws?._instStorageHistory) + len(ws?._instStorageEvents) > 0, !!ws?._instStorageHistory), [
    { field: 'storage_history', count: len(ws?._instStorageHistory) },
    { field: 'storage_events', count: len(ws?._instStorageEvents) },
    { field: 'indexed_db', count: len(ws?._instIndexedDb), error: errorOf(ws, '_instIndexedDbError') },
  ]);
  add('I.workers.contexts', 'I', 'worker inventory and events', 'worker global surface snapshots plus Runtime/Network events', status(len(ws?._instWorkerSurfaces) + len(ws?._instWorkerEvents) > 0, !!ws?._instWorkerSurfaces), [
    { field: 'worker_surfaces', count: len(ws?._instWorkerSurfaces), error: errorOf(ws, '_instWorkerSurfacesError') },
    { field: 'worker_events', count: len(ws?._instWorkerEvents) },
  ]);
  const rtcCount = countAccess(logs, 'RTCPeerConnection');
  add('J.webrtc.page_hooks', 'J', 'WebRTC page hooks', 'SDP, ICE, and getStats observed from page calls', status(rtcCount > 0, accessCount > 0), [
    { field: 'accesses.RTCPeerConnection', count: rtcCount },
  ]);
  const inputCount = countAccess(logs, 'Input');
  add('K.trajectory.input_events', 'K', 'input event recorder', 'pointer, keyboard, wheel, scroll, focus, blur, and value changes', status(inputCount > 0, accessCount > 0), [
    { field: 'accesses.Input', count: inputCount },
  ]);
  add('M.artifacts.sibling_manifest', 'M', 'recording artifact manifest', 'sibling screenshots, DOM, video, pcap, netlog, and aux files', status(!!ws?._instDir, !!ws?._instDir), [
    { field: 'sibling_files_available_at_serialize', present: !!ws?._instDir },
  ]);

  const missing = 'A.js_native_matrix|A.wasm_matrix|B.media_matrix|B.css_svg_mathml_matrix|D.decoded_transport_fingerprints|E.deep_host_inventory|G.dom_resource_accessibility_graph|H.identity_privacy_adtech_state|L.schema_validation'.split('|');
  for (const id of missing) {
    const section = id.slice(0, 1);
    add(id, section, 'not wired in current diagnostics', 'canonical todo collector surface', 'missing', []);
  }

  const summary = { emitted: 0, attempted: 0, missing: 0 };
  for (const c of collectors) summary[c.status]++;
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    summary,
    collectors,
  };
}
