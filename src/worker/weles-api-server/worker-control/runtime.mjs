// The browser runtime as the worker's status reports it. The probe runs the
// packaged encoder through the same inspector `weles doctor` runs, on a
// worker thread of its own (`runtime-probe-worker.mjs`): the inspector reads
// the Playwright manifest and stats the encoder synchronously before it runs
// it, so on the API's thread a disk that stops answering would stop every
// request. A status read never waits on the probe: it answers the last
// finished report with when it was probed, and starts one probe when none
// runs; at most one probe runs at a time, and each start and end is logged
// as the API's other waits are.

import { Worker } from 'node:worker_threads';

export function createRuntimeProbe() {
  // The last finished probe: its report and when it finished; and when the
  // probe running now started, if one runs.
  let last = null;
  let probingSince = null;

  function finished(report, since) {
    last = { report, probedAt: new Date().toISOString() };
    probingSince = null;
    console.log(
      JSON.stringify({
        event: 'browser_runtime_probe',
        state: 'finished',
        since,
        probedAt: last.probedAt,
        ok: report.ok,
      }),
    );
  }

  function start() {
    if (probingSince !== null) return;
    const since = new Date().toISOString();
    probingSince = since;
    console.log(
      JSON.stringify({
        event: 'browser_runtime_probe',
        state: 'started',
        since,
      }),
    );
    // The worker posts one report. A constructor that throws ends the probe
    // as the runtime's failure before start returns; everything that fails
    // once the thread exists, a module that cannot load included, arrives as
    // its error or exit and ends it then. None is left probing.
    let reported = false;
    const failed = (error) => {
      if (reported) return;
      reported = true;
      const cause =
        error instanceof Error ? error.stack || error.message : String(error);
      finished(
        { ok: false, error: `the browser runtime probe failed: ${cause}` },
        since,
      );
    };
    let worker;
    try {
      worker = new Worker(
        new URL('./runtime-probe-worker.mjs', import.meta.url),
      );
    } catch (error) {
      failed(error);
      return;
    }
    worker.once('message', (report) => {
      if (reported) return;
      reported = true;
      finished(report, since);
    });
    worker.once('error', failed);
    worker.once('exit', (code) =>
      failed(`its worker thread exited with code ${code} before reporting`),
    );
  }

  // What a status read answers now: the last report with when it was
  // probed, and whether a newer probe is running since when. A read starts
  // a probe when none runs, so the next read answers a fresher report.
  function read() {
    start();
    return {
      report: last === null ? null : last.report,
      probedAt: last === null ? null : last.probedAt,
      probingSince,
      said:
        last === null
          ? `probing since ${probingSince}, no report yet`
          : probingSince === null
            ? `probed at ${last.probedAt}`
            : `probed at ${last.probedAt}; probing again since ${probingSince}`,
    };
  }

  return Object.freeze({ start, read });
}
