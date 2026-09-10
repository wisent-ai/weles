// The environment the rotating LinkedIn probe runs with. Everything it writes lands beside
// the run's recordings, never in a work directory inside the checkout.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../../../../dist/session/run-recordings.js';

export const OUT = runRecordingsDir('linkedin_rotating_weles_probe');
export const WORK = join(OUT, 'work');
mkdirSync(OUT, { recursive: true });
mkdirSync(WORK, { recursive: true });

export const SAMPLES_PER_PROVIDER = Math.max(1, Number(process.env.LINKEDIN_WPROBE_SAMPLES || 1));
export const TARGET_CC = (process.env.LINKEDIN_WPROBE_COUNTRY || 'us').toLowerCase();
export const SUBMIT_CANDIDATE = process.env.LINKEDIN_WPROBE_SUBMIT === '1';
export const STOP_AFTER_SUBMIT = process.env.LINKEDIN_WPROBE_STOP_AFTER_SUBMIT !== '0';
export const PROBE_OS = process.env.LINKEDIN_WPROBE_OS || 'windows';
export const INCLUDE = new Set(String(process.env.LINKEDIN_WPROBE_INCLUDE || 'oxylabs mobile,oxylabs residential,packetstream,bright data')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean));
