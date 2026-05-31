// Per-session packet capture via tcpdump. Pairs with the SSLKEYLOGFILE Chrome
// writes to recordings/<label>/sslkey.log; together they let Wireshark or
// tshark decrypt the TLS payload and reveal HTTP/2 SETTINGS / WINDOW_UPDATE /
// PRIORITY / HEADERS frames the page exchanged with the server — the
// fingerprint layer Akamai's H2 hash measures.
//
// macOS: /usr/sbin/tcpdump usually needs sudo or BPF device perms. We try
// once, capture the spawn outcome (pid, exit, stderr first line), and let the
// session continue without capture if it fails — the SSL keys are still
// captured, so a user with sudo access can re-run with tcpdump separately.

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

const TCPDUMP_PATH = '/usr/sbin/tcpdump';

// Defaults to en0 on macOS, eth0 on Linux. The right interface depends on the
// host network setup; allow a WELES_PCAP_IFACE override for hosts where en0
// isn't the active route.
function defaultInterface(): string {
  if (process.env.WELES_PCAP_IFACE) return process.env.WELES_PCAP_IFACE;
  return process.platform === 'darwin' ? 'en0' : 'eth0';
}

export interface PcapStatus {
  enabled: boolean;
  iface: string | null;
  path: string | null;
  pid: number | null;
  exit_code: number | null;
  exit_signal: string | null;
  stderr: string;
  spawn_error: string | null;
}

export function startPcap(ws: any, label: string | undefined): void {
  const status: PcapStatus = {
    enabled: false, iface: null, path: null, pid: null,
    exit_code: null, exit_signal: null, stderr: '', spawn_error: null,
  };
  ws._instPcap = status;
  if (!label) { status.spawn_error = 'no label'; return; }
  const iface = defaultInterface();
  const outPath = join(process.cwd(), 'recordings', label, 'traffic.pcap');
  status.iface = iface;
  status.path = outPath;
  let child: ChildProcess;
  try {
    // -i <iface> capture interface; -w <path> raw pcap output; -U pack each
    // packet immediately (don't buffer); -B 16384 bigger BPF buffer to reduce
    // drops. NO filter — capture everything on the iface for the session.
    child = spawn(TCPDUMP_PATH, ['-i', iface, '-w', outPath, '-U', '-B', '16384'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e: any) { status.spawn_error = String(e?.message ?? e); return; }
  status.enabled = true;
  status.pid = child.pid ?? null;
  child.stderr?.on('data', (d) => { status.stderr = (status.stderr + d.toString()).slice(0, 4000); });
  child.on('exit', (code, signal) => { status.exit_code = code; status.exit_signal = signal; });
  child.on('error', (err) => { status.spawn_error = String(err?.message ?? err); });
  ws._instPcapChild = child;
}

// Worker auto-attach + inventory. Worker JS contexts (Web/Shared/Service) are
// NOT reachable via context.addInitScript — the SURFACE_INVENTORY_SCRIPT only
// runs in document contexts. CDP Target.setAutoAttach gives a child session
// per worker; for each we run a one-shot Runtime.evaluate to enumerate
// Object.getOwnPropertyNames(self) + .navigator. Result lands in
// ws._instWorkerSurfaces. Lives here (not in capture_extras.ts) because that
// file is at the 300-line cap.
export function attachWorkerInventory(ws: any): void {
  const cdp = ws?._cdp;
  if (!cdp) return;
  ws._instWorkerSurfaces = [];
  void (async () => {
    try { await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }); }
    catch (e: any) { ws._instWorkerSurfacesError = String(e?.message ?? e); }
  })();
  cdp.on('Target.attachedToTarget', async (e: any) => {
    try {
      const sessId = e?.sessionId; const ti = e?.targetInfo;
      if (!sessId || !ti) return;
      const childCdp = (cdp as any)._connection?.session?.(sessId) ?? (cdp as any).session?.(sessId) ?? null;
      let inv: any = null; let err: string | null = null;
      if (childCdp) {
        try { inv = await childCdp.send('Runtime.evaluate', { expression: 'JSON.stringify({selfNames:Object.getOwnPropertyNames(self),navNames:Object.getOwnPropertyNames(self.navigator||{}),ua:(self.navigator&&self.navigator.userAgent)||null,scope:String(self.constructor&&self.constructor.name)})', returnByValue: true }); }
        catch (e2: any) { err = String(e2?.message ?? e2); }
        // Subscribe Runtime + Network on the worker session so events beyond
        // the initial snapshot land in ws._instWorkerEvents.
        if (!ws._instWorkerEvents) ws._instWorkerEvents = [];
        const we = ws._instWorkerEvents;
        try { await childCdp.send('Runtime.enable'); } catch {}
        try { await childCdp.send('Network.enable'); } catch {}
        childCdp.on('Runtime.consoleAPICalled', (ev: any) => { try { we.push({ t: Date.now(), targetId: ti.targetId, phase: 'console', payload: ev }); } catch {} });
        childCdp.on('Runtime.exceptionThrown', (ev: any) => { try { we.push({ t: Date.now(), targetId: ti.targetId, phase: 'exception', payload: ev }); } catch {} });
        childCdp.on('Network.requestWillBeSent', (ev: any) => { try { we.push({ t: Date.now(), targetId: ti.targetId, phase: 'request', payload: ev }); } catch {} });
        childCdp.on('Network.responseReceived', (ev: any) => { try { we.push({ t: Date.now(), targetId: ti.targetId, phase: 'response', payload: ev }); } catch {} });
        childCdp.on('Network.loadingFailed', (ev: any) => { try { we.push({ t: Date.now(), targetId: ti.targetId, phase: 'loadingFailed', payload: ev }); } catch {} });
      } else { err = 'no child cdp session handle'; }
      ws._instWorkerSurfaces.push({ t: Date.now(), targetType: ti.type, targetUrl: ti.url, targetId: ti.targetId, sessionId: sessId, inventory: inv, inventory_error: err });
    } catch (err: any) { ws._instWorkerSurfaces.push({ t: Date.now(), phase: 'attach-handler-error', err: String(err?.message ?? err) }); }
  });
}

export async function stopPcap(ws: any): Promise<void> {
  const child: ChildProcess | undefined = ws?._instPcapChild;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill('SIGINT'); } catch {}
  // Give tcpdump a tick to flush the pcap header + last packets to disk.
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}
