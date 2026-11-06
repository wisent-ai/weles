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
import { runRecordingsDir } from '../run-recordings.js';

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
    enabled: false,
    iface: null,
    path: null,
    pid: null,
    exit_code: null,
    exit_signal: null,
    stderr: '',
    spawn_error: null,
  };
  ws._instPcap = status;
  if (!label) {
    status.spawn_error = 'no label';
    return;
  }
  const iface = defaultInterface();
  const outPath = join(runRecordingsDir(label), 'traffic.pcap'); // G17: recordings/<run_uuid>/<label>/
  status.iface = iface;
  status.path = outPath;
  let child: ChildProcess;
  try {
    // -i <iface> capture interface; -w <path> raw pcap output; -U pack each
    // packet immediately (don't buffer); -B 16384 bigger BPF buffer to reduce
    // drops. NO filter — capture everything on the iface for the session.
    child = spawn(
      TCPDUMP_PATH,
      ['-i', iface, '-w', outPath, '-U', '-B', '16384'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (e: any) {
    status.spawn_error = String(e?.message ?? e);
    return;
  }
  status.enabled = true;
  // A spawn that did not get a pid failed; its error event fills spawn_error.
  if (child.pid !== undefined) status.pid = child.pid;
  child.stderr?.on('data', (d) => {
    status.stderr = status.stderr + d.toString();
  });
  child.on('exit', (code, signal) => {
    status.exit_code = code;
    status.exit_signal = signal;
  });
  child.on('error', (err) => {
    status.spawn_error = String(err?.message ?? err);
  });
  ws._instPcapChild = child;
}

// Worker auto-attach + inventory. Worker JS contexts (Web/Shared/Service) are
// NOT reachable via context.addInitScript — the SURFACE_INVENTORY_SCRIPT only
// runs in document contexts. CDP Target.setAutoAttach gives a child session
// per worker; for each we run a one-shot Runtime.evaluate to enumerate
// Object.getOwnPropertyNames(self) + .navigator. Result lands in
// ws._instWorkerSurfaces. Lives here (not in capture_extras.ts) because that
// file is at the 300-line cap.

/** The CDP session of one attached worker: what the inventory sends to and listens on. */
type WorkerSession = {
  send(method: string, params?: object): Promise<unknown>;
  on(event: string, listener: (event: unknown) => void): void;
};

/** The handles a Playwright CDP session may expose for opening a child session. */
type SessionOpener = {
  _connection?: { session?: (sessionId: string) => WorkerSession | undefined };
  session?: (sessionId: string) => WorkerSession | undefined;
};

/** The CDP session the connection opened for an attached worker, from whichever handle this Playwright exposes; null when neither does. */
function workerSession(
  cdp: SessionOpener,
  sessionId: string,
): WorkerSession | null {
  const viaConnection = cdp._connection?.session?.(sessionId);
  if (viaConnection) return viaConnection;
  const direct = cdp.session?.(sessionId);
  if (direct) return direct;
  return null;
}

export function attachWorkerInventory(ws: any): void {
  const cdp = ws?._cdp;
  if (!cdp) return;
  ws._instWorkerSurfaces = [];
  void (async () => {
    try {
      await cdp.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
    } catch (e: any) {
      ws._instWorkerSurfacesError = String(e?.message ?? e);
    }
  })();
  cdp.on('Target.attachedToTarget', async (e: any) => {
    try {
      const sessId = e?.sessionId;
      const ti = e?.targetInfo;
      if (!sessId || !ti) return;
      const childCdp = workerSession(cdp, sessId);
      let inv: any = null;
      let err: string | null = null;
      if (childCdp) {
        try {
          inv = await childCdp.send('Runtime.evaluate', {
            expression:
              'JSON.stringify({selfNames:Object.getOwnPropertyNames(self),navNames:Object.getOwnPropertyNames(self.navigator||{}),ua:(self.navigator&&self.navigator.userAgent)||null,scope:String(self.constructor&&self.constructor.name)})',
            returnByValue: true,
          });
        } catch (e2: any) {
          err = String(e2?.message ?? e2);
        }
        // Subscribe Runtime + Network on the worker session so events beyond
        // the initial snapshot land in ws._instWorkerEvents.
        if (!ws._instWorkerEvents) ws._instWorkerEvents = [];
        const we = ws._instWorkerEvents;
        try {
          await childCdp.send('Runtime.enable');
        } catch (enableError: any) {
          // Without Runtime the worker's console and exceptions never arrive.
          we.push({
            t: Date.now(),
            targetId: ti.targetId,
            phase: 'enable_failed',
            payload: {
              domain: 'Runtime',
              error: String(enableError?.message ?? enableError),
            },
          });
        }
        try {
          await childCdp.send('Network.enable');
        } catch (enableError: any) {
          // Without Network the worker's requests and responses never arrive.
          we.push({
            t: Date.now(),
            targetId: ti.targetId,
            phase: 'enable_failed',
            payload: {
              domain: 'Network',
              error: String(enableError?.message ?? enableError),
            },
          });
        }
        // Each worker event is kept with its phase; pushing to an array does not fail, so nothing is caught here.
        const WORKER_EVENTS: Record<string, string> = {
          'Runtime.consoleAPICalled': 'console',
          'Runtime.exceptionThrown': 'exception',
          'Network.requestWillBeSent': 'request',
          'Network.responseReceived': 'response',
          'Network.loadingFailed': 'loadingFailed',
        };
        for (const [event, phase] of Object.entries(WORKER_EVENTS)) {
          childCdp.on(event, (ev: unknown) => {
            we.push({
              t: Date.now(),
              targetId: ti.targetId,
              phase,
              payload: ev,
            });
          });
        }
      } else {
        err = 'no child cdp session handle';
      }
      ws._instWorkerSurfaces.push({
        t: Date.now(),
        targetType: ti.type,
        targetUrl: ti.url,
        targetId: ti.targetId,
        sessionId: sessId,
        inventory: inv,
        inventory_error: err,
      });
    } catch (err: any) {
      ws._instWorkerSurfaces.push({
        t: Date.now(),
        phase: 'attach-handler-error',
        err: String(err?.message ?? err),
      });
    }
  });
}

export async function stopPcap(ws: any): Promise<void> {
  const child: ChildProcess | undefined = ws?._instPcapChild;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  // A tcpdump that did not take the signal keeps capturing past the session;
  // kill() reports an undelivered signal by returning false, and the failure
  // goes on the pcap status the dump writes.
  let stopError: string | null = null;
  try {
    if (!child.kill('SIGINT'))
      stopError = `SIGINT not delivered to tcpdump pid ${child.pid}`;
  } catch (e: any) {
    stopError = `SIGINT to tcpdump pid ${child.pid} failed: ${String(e?.message ?? e)}`;
  }
  if (stopError) {
    if (ws._instPcap) ws._instPcap.stop_error = stopError;
    console.error(`[pcap] ${stopError}`);
  }
  // Give tcpdump a tick to flush the pcap header + last packets to disk.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}
