/**
 * The declared observation this run was admitted with.
 *
 * Admission resolved src/worker/deploy/weles-observation-declaration.json in
 * the dispatcher and put the result in the child's env, so the origin a run
 * reads and the dwell budget it spends are declaration content, not a table
 * inside a trajectory. A reviewed observation trajectory is reachable only
 * through that admission step, so an absent variable is a broken caller, not
 * a default to invent: every one of these refuses instead of guessing.
 */

function required(name) {
  const value = (process.env[name] ?? '').trim();
  if (!value) {
    throw new Error(`${name} is required: an observation trajectory runs only from a declared observation`);
  }
  return value;
}

export function declaredObservation() {
  const observation = required('GENERIC_OBSERVATION');
  const [platform, verb] = observation.split('.');
  const scrolls = Number.parseInt(required('GENERIC_OBSERVATION_SCROLLS'), 10);
  if (!Number.isInteger(scrolls) || scrolls < 0) {
    throw new Error(`GENERIC_OBSERVATION_SCROLLS must be a whole scroll budget, not ${process.env.GENERIC_OBSERVATION_SCROLLS}`);
  }
  const dwellMs = required('GENERIC_OBSERVATION_DWELL_MS').split(',').map((part) => Number.parseInt(part, 10));
  if (dwellMs.length !== 2 || dwellMs.some((ms) => !Number.isInteger(ms) || ms <= 0) || dwellMs[1] < dwellMs[0]) {
    throw new Error(`GENERIC_OBSERVATION_DWELL_MS must be an ascending millisecond range, not ${process.env.GENERIC_OBSERVATION_DWELL_MS}`);
  }
  return {
    observation,
    platform,
    verb,
    origin: required('GENERIC_OBSERVATION_ORIGIN'),
    reads: required('GENERIC_OBSERVATION_READS'),
    scrolls,
    dwellMs,
  };
}
