import type { BrowserContext } from 'playwright';

export interface InstrumentationCheckpoints {
  checkpoint(reason: string): Promise<void>;
  stop(): Promise<void>;
  captureFinal(): Promise<void>;
}

/** Serialize activity-triggered captures without a timer or overlapping writes. */
export function attachInstrumentationCheckpoints(
  ws: any,
  ctx: BrowserContext,
  options: { cdpDiagnostics: boolean; storageDiagnostics: boolean },
  persist: () => void,
): InstrumentationCheckpoints {
  let queued: Set<string> | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  let stopped = false;
  ws._instCheckpointErrors = [];

  const recordError = (operation: string, error: unknown, url = ws.page?.url?.() ?? null) => {
    const message = error instanceof Error ? error.message : String(error);
    ws._instCheckpointErrors.push({ t: Date.now(), operation, error: message, url });
    console.error(`[wsession] instrumentation ${operation} failed: ${message}`);
  };

  async function capturePage(): Promise<void> {
    const page = ws.page;
    if (!page || page.isClosed?.()) return;
    for (const frame of page.frames()) {
      try {
        const encoded: string = await frame.evaluate('(()=>{const a=globalThis[Symbol.for("weles.inst")];if(!a||typeof a.flush!=="function")throw new Error("weles.inst.flush is unavailable");return a.flush()})()'); // allow-raw-playwright: instrumentation flush
        const log = JSON.parse(encoded);
        if (!Array.isArray(log)) throw new Error('weles.inst.flush returned a non-array log');
        if (!log.length) continue;
        const url = frame.url();
        const previous = ws._instAccum.get(url);
        if (!previous || log.length > previous.log.length) ws._instAccum.set(url, { url, log });
      } catch (error) {
        recordError('frame access-log capture', error, frame.url());
      }
    }
    try {
      const html: string = await page.content(); // allow-raw-playwright: dom timeline snapshot
      const url = page.url();
      const last = ws._instDomTimeline[ws._instDomTimeline.length - 1];
      if (!last || last.url !== url || last.html !== html) {
        ws._instDomTimeline.push({ t: Date.now(), url, len: html.length, html });
        if (ws._instDomTimeline.length > 80) ws._instDomTimeline.shift();
      }
    } catch (error) {
      recordError('page DOM capture', error);
    }
  }

  async function captureOptionalState(): Promise<void> {
    if (options.cdpDiagnostics && ws._cdp) {
      try {
        const result = await ws._cdp.send('Performance.getMetrics');
        ws._instMetricsHistory.push({ t: Date.now(), metrics: result.metrics });
      } catch (error) { recordError('Performance.getMetrics', error); }
      try {
        const result = await ws._cdp.send('Memory.getDOMCounters');
        ws._instDomCounters.push({ t: Date.now(), counters: result });
      } catch (error) { recordError('Memory.getDOMCounters', error); }
    }
    if (options.storageDiagnostics) {
      try {
        const state = await ctx.storageState();
        ws._instStorageHistory.push({ t: Date.now(), state });
      } catch (error) { recordError('BrowserContext.storageState', error); }
    }
  }

  async function capture(triggeredBy: string[]): Promise<void> {
    await ws._cdpDiagnosticsReady;
    await capturePage();
    await captureOptionalState();
    ws._instLastCheckpoint = { t: Date.now(), reasons: triggeredBy };
  }

  function checkpoint(reason: string): Promise<void> {
    if (stopped) return inFlight;
    if (queued) {
      queued.add(reason);
      return inFlight;
    }
    const batch = new Set([reason]);
    queued = batch;
    // Each caller observes its own batch, not eventual browser quiescence.
    // Activity during collection forms the next batch without overlapping it.
    inFlight = inFlight.then(async () => {
      queued = null;
      try { await capture([...batch]); }
      catch (error) { recordError('checkpoint collection', error); }
      try { persist(); }
      catch (error) { recordError('artifact publication', error); }
    });
    return inFlight;
  }

  const requestFinished = () => { void checkpoint('requestfinished'); };
  const requestFailed = () => { void checkpoint('requestfailed'); };
  const navigated = () => { void checkpoint('framenavigated'); };
  const loaded = () => { void checkpoint('domcontentloaded'); };
  const pageError = () => { void checkpoint('pageerror'); };
  const crashed = () => {
    recordError('page crash', 'page crashed before final instrumentation capture');
    void checkpoint('crash');
  };
  const closed = () => {
    recordError('page close', 'page closed before final instrumentation capture');
    void checkpoint('close');
  };

  // Context storage capture may use an internal page. Only the session page's
  // requests trigger another checkpoint, avoiding capture-generated feedback.
  ws.page.on('requestfinished', requestFinished);
  ws.page.on('requestfailed', requestFailed);
  ws.page.on('framenavigated', navigated);
  ws.page.on('domcontentloaded', loaded);
  ws.page.on('pageerror', pageError);
  ws.page.on('crash', crashed);
  ws.page.on('close', closed);

  async function stop(): Promise<void> {
    if (!stopped) {
      stopped = true;
      ws.page.off('requestfinished', requestFinished);
      ws.page.off('requestfailed', requestFailed);
      ws.page.off('framenavigated', navigated);
      ws.page.off('domcontentloaded', loaded);
      ws.page.off('pageerror', pageError);
      ws.page.off('crash', crashed);
      ws.page.off('close', closed);
    }
    await inFlight;
  }

  void checkpoint('start');
  return {
    checkpoint,
    stop,
    async captureFinal() {
      await stop();
      await capture(['close']);
    },
  };
}
