// What a running account run (`./reauth-process.mjs`) has reached, read from
// its stderr as it writes it: each `STEP <stage>` line and the request a
// line `OPERATOR_REQUEST <json>` opens. Every change is kept in the run's
// own record, so the diagnostics route answers "what is it doing" for a
// caller that was not listening, and handed to the caller's `onProgress`.

import { RUN_RELEASE_IDENTITY } from '../../release-identity.mjs';
import { persistRunResult } from '../run-outcome.mjs';

const OPERATOR_REQUEST = 'OPERATOR_REQUEST ';

/**
 * The progress of the run `runId` (`action`, begun at `startedAt`), kept in
 * `runResultPath` and handed to `onProgress`. A record that cannot be
 * written and a caller that cannot take an event do not end the run: the
 * first cause of each is kept for the finished result.
 */
export function runProgress({
  runId,
  action,
  startedAt,
  runResultPath,
  onProgress,
}) {
  const stages = [];
  let lastStage = null;
  let operatorRequest = null;
  let recordError = null;
  let deliveryError = null;
  let pendingLine = '';
  const record = () => {
    try {
      persistRunResult(runResultPath, {
        ...RUN_RELEASE_IDENTITY,
        action,
        run_id: runId,
        status: 'running',
        started_at: startedAt,
        completed_at: null,
        stages,
        operator_request: operatorRequest,
      });
    } catch (error) {
      recordError = `run progress could not be recorded: ${String(error?.message || error)}`;
    }
  };
  // A caller that went away does not end the run; the result names why.
  const deliver = (event) => {
    try {
      onProgress(event);
    } catch (error) {
      if (deliveryError === null)
        deliveryError = `progress event ${event.event} could not be delivered: ${String(error?.message || error)}`;
    }
  };
  const readLine = (line) => {
    const at = new Date().toISOString();
    const step = /^STEP (?<stage>\S+)\s*$/.exec(line);
    if (step) {
      lastStage = { stage: step.groups.stage, at };
      stages.push(lastStage);
      record();
      deliver({ event: 'stage', run_id: runId, stage: lastStage.stage, at });
      return;
    }
    if (!line.startsWith(OPERATOR_REQUEST)) return;
    try {
      operatorRequest = JSON.parse(line.slice(OPERATOR_REQUEST.length));
    } catch (error) {
      operatorRequest = { unreadable: String(error?.message || error), line };
    }
    record();
    deliver({
      event: 'operator_request',
      run_id: runId,
      at,
      request: operatorRequest,
    });
  };
  return {
    stages,
    deliver,
    /** Read a chunk of stderr; a line not yet ended waits for the next chunk. */
    read(chunk) {
      const lines = `${pendingLine}${chunk}`.split('\n');
      pendingLine = lines.pop();
      for (const line of lines) readLine(line);
    },
    get lastStage() {
      return lastStage;
    },
    get operatorRequest() {
      return operatorRequest;
    },
    get recordError() {
      return recordError;
    },
    get deliveryError() {
      return deliveryError;
    },
  };
}
