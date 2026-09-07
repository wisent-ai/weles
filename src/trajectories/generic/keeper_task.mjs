import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// generic_keeper_task runs one of two things, and admission decided which
// before this process existed:
//
//   * a declared observation — GENERIC_OBSERVATION plus the reviewed
//     trajectory, origin, dwell budget and reading the declaration names, all
//     set by the dispatcher's admission step; or
//   * the keeper's own objective, driven by browser_task with the keeper
//     phase first, which is what src/secrets/acquire.ts queues.
//
// The observation path is what replaced the 37 per-site benign-activity
// verbs. src/worker/deploy/weles-observation-declaration.json is the only
// thing that says which reviewed trajectory an observation reads and where,
// so nothing here maps a platform or a verb to a path: this file runs what
// admission already authorized, or it runs the objective it was given.

const observation = process.env.GENERIC_OBSERVATION || '';
const observationTrajectory = process.env.GENERIC_OBSERVATION_TRAJECTORY || '';

if (observation) {
  // Admission resolved the declaration before this process existed. If the
  // reviewed trajectory did not arrive with the observation, the run refuses
  // rather than guessing a path from the observation name.
  if (!observationTrajectory) {
    throw new Error(`declared observation ${observation} reached execution without its reviewed trajectory`);
  }
  const repositoryRoot = process.env.WELES_REPO || resolve(import.meta.dirname, '..', '..', '..');
  console.log(`[keeper-task] observation ${observation} -> ${observationTrajectory}`);
  await import(pathToFileURL(join(repositoryRoot, observationTrajectory)).href);
} else {
  process.env.GENERIC_TASK_LABEL = process.env.GENERIC_TASK_LABEL || 'generic_keeper_task';
  process.env.GENERIC_TASK_KEEPER_FIRST = '1';
  await import('./browser_task.mjs');
}
