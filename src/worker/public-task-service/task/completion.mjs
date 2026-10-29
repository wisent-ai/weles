// How a browser evidence task ends: cancelled, failed, or succeeded with the
// capture whose requested, effective and final URLs agree, and the digest of
// the result the task register keeps.
import { canonicalJson, digest, isObject } from '../wire/canonical-json.mjs';

// The run id a trajectory reported; null records that it reported none.
function reportedRunId(output) {
  return typeof output?.run_id === 'string' ? output.run_id : null;
}

// One URL field of a capture: absent, parsed, or refused naming field and text.
function captureUrl(captureResult, field) {
  const text = captureResult?.[field];
  if (typeof text !== 'string') return { url: null, problem: null };
  if (!URL.canParse(text)) {
    return {
      url: null,
      problem: `${field} ${JSON.stringify(text)} does not parse as a URL`,
    };
  }
  return { url: new URL(text).toString(), problem: null };
}

export function terminalCompletion(output, aborted, _redact, requestedUrl) {
  let completion;
  if (aborted || output?.cancelled) {
    completion = {
      status: 'cancelled',
      result: { state: 'cancelled' },
      error: null,
      capture: null,
    };
  } else if (output?.ok) {
    const captureResult = isObject(output.result) ? output.result : null;
    const effective = captureUrl(captureResult, 'url');
    const final = captureUrl(captureResult, 'final_url');
    const effectiveUrl = effective.url;
    const finalUrl = final.url;
    const urlProblem = effective.problem ? effective.problem : final.problem;
    const captureValid =
      typeof requestedUrl === 'string' &&
      effectiveUrl === requestedUrl &&
      typeof finalUrl === 'string' &&
      new URL(finalUrl).origin === new URL(requestedUrl).origin;
    if (!captureValid) {
      completion = {
        status: 'failed',
        result: { state: 'failed', executionRunId: reportedRunId(output) },
        error: urlProblem
          ? `browser evidence capture reported a URL that does not parse: ${urlProblem}`
          : 'browser evidence capture identity is missing or inconsistent',
        capture: { requestedUrl, effectiveUrl, finalUrl },
      };
    } else {
      const value = { requestedUrl, effectiveUrl, finalUrl };
      completion = {
        status: 'succeeded',
        result: { state: 'succeeded', value, executionRunId: output.run_id },
        error: null,
        capture: value,
      };
    }
  } else {
    completion = {
      status: 'failed',
      result: { state: 'failed', executionRunId: reportedRunId(output) },
      error: 'browser evidence task failed',
      capture: { requestedUrl, effectiveUrl: null, finalUrl: null },
    };
  }
  return {
    ...completion,
    resultDigest: digest(canonicalJson(completion.result)),
  };
}
