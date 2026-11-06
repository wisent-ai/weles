// Coverage probes of what the browser's protocol, network and storage
// collectors recorded: the CDP firehose and snapshots, metrics, tracing and
// coverage, network capture, pcap, storage state and workers.
import { cdpTargets, errorOf, len, present, type Probe } from './read.js';

export const PROTOCOL_PROBES: readonly Probe[] = [
  {
    id: 'C.cdp.firehose',
    collector: 'CDP event firehose',
    expected: 'every subscribed CDP event, whole',
    emitted: (ws) =>
      Boolean(
        len(ws._instCdpFirehose) + cdpTargets(ws) + len(ws._instFrameEvents),
      ),
    attempted: (ws) => Boolean(ws._cdpDiagnosticsReady),
    evidence: (ws) => [
      { field: 'cdp_firehose', count: len(ws._instCdpFirehose) },
      {
        field: 'cdp_targets',
        count: cdpTargets(ws),
        error: errorOf(ws, '_cdpAttachError'),
      },
      { field: 'cdp_frames', count: len(ws._instFrameEvents) },
    ],
  },
  {
    id: 'C.cdp.final_snapshots',
    collector: 'final CDP snapshots',
    expected: 'DOMSnapshot, pierced DOM, heap snapshot, browser/process state',
    emitted: (ws) =>
      present(ws._instDomSnapshot) || present(ws._instHeapSnapshot),
    attempted: (ws) => Boolean(ws._cdp),
    evidence: (ws) => [
      {
        field: 'dom_snapshot',
        present: present(ws._instDomSnapshot),
        error: errorOf(ws, '_instDomSnapshotError'),
      },
      {
        field: 'dom_pierced_tree',
        present: present(ws._instDomPiercedTree),
        error: errorOf(ws, '_instDomPiercedTreeError'),
      },
      {
        field: 'heap_snapshot',
        present: present(ws._instHeapSnapshot),
        error: errorOf(ws, '_instHeapSnapshotError'),
      },
      { field: 'system_info', present: present(ws._instSystemInfo) },
    ],
  },
  {
    id: 'C.cdp.metrics_tracing_coverage',
    collector: 'metrics, tracing, and coverage',
    expected:
      'Performance/Memory activity checkpoints, Tracing, JS/CSS coverage',
    emitted: (ws) =>
      Boolean(len(ws._instMetricsHistory) + len(ws._instTracing)) ||
      present(ws._instJsCoverageData),
    attempted: (ws) => Boolean(ws._cdp),
    evidence: (ws) => [
      { field: 'cdp_metrics', count: len(ws._instMetricsHistory) },
      {
        field: 'cdp_tracing',
        count: len(ws._instTracing),
        error: errorOf(ws, '_instTracingError'),
      },
      {
        field: 'js_coverage',
        present: present(ws._instJsCoverageData),
        error: errorOf(ws, '_instJsCoverageError'),
      },
      {
        field: 'css_coverage',
        present: present(ws._instCssCoverageData),
        error: errorOf(ws, '_instCssCoverageError'),
      },
    ],
  },
  {
    id: 'D.network.playwright',
    collector: 'Playwright network/body capture',
    expected: 'requests, responses, failures, bodies, WebSocket frames',
    emitted: (ws) => Boolean(len(ws._instRequests)),
    attempted: (ws) => Boolean(ws._instRequests),
    evidence: (ws) => [{ field: 'requests', count: len(ws._instRequests) }],
  },
  {
    id: 'D.network.cdp_extra',
    collector: 'CDP network extra-info',
    expected:
      'wire headers, cookie blocking, cache, WebSocket handshake events',
    emitted: (ws) => Boolean(len(ws._instCdpNetwork)),
    attempted: (ws) => Boolean(ws._cdp),
    evidence: (ws) => [
      { field: 'cdp_network', count: len(ws._instCdpNetwork) },
    ],
  },
  {
    id: 'D.network.pcap',
    collector: 'pcap sidecar',
    expected: 'tcpdump pcap plus SSLKEYLOGFILE path/status',
    emitted: (ws) =>
      Boolean(ws._instPcap) &&
      Boolean(ws._instPcap.enabled) &&
      !ws._instPcap.spawn_error,
    attempted: (ws) => Boolean(ws._instPcap),
    evidence: (ws) => [
      {
        field: 'pcap.enabled',
        present: Boolean(ws._instPcap) && Boolean(ws._instPcap.enabled),
        error:
          ws._instPcap && ws._instPcap.spawn_error
            ? String(ws._instPcap.spawn_error)
            : null,
      },
    ],
  },
  {
    id: 'H.storage.state',
    collector: 'browser storage state',
    expected: 'context storage snapshots and storage events',
    emitted: (ws) =>
      Boolean(len(ws._instStorageHistory) + len(ws._instStorageEvents)),
    attempted: (ws) => Boolean(ws._instStorageHistory),
    evidence: (ws) => [
      { field: 'storage_history', count: len(ws._instStorageHistory) },
      { field: 'storage_events', count: len(ws._instStorageEvents) },
      {
        field: 'indexed_db',
        count: len(ws._instIndexedDb),
        error: errorOf(ws, '_instIndexedDbError'),
      },
    ],
  },
  {
    id: 'I.workers.contexts',
    collector: 'worker inventory and events',
    expected: 'worker global surface snapshots plus Runtime/Network events',
    emitted: (ws) =>
      Boolean(len(ws._instWorkerSurfaces) + len(ws._instWorkerEvents)),
    attempted: (ws) => Boolean(ws._instWorkerSurfaces),
    evidence: (ws) => [
      {
        field: 'worker_surfaces',
        count: len(ws._instWorkerSurfaces),
        error: errorOf(ws, '_instWorkerSurfacesError'),
      },
      { field: 'worker_events', count: len(ws._instWorkerEvents) },
    ],
  },
];
