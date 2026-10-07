// The environment the rotating LinkedIn probe runs with. Everything it writes lands beside
// the run's recordings, never in a work directory inside the checkout.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../../../../dist/session/run-recordings.js';
import { parseInclude } from '../../../../_shared/skarbiec/proxies.mjs';
import { statedCount } from '../../../../_shared/inputs/stated.mjs';

export const OUT = runRecordingsDir('linkedin_rotating_weles_probe');
export const WORK = join(OUT, 'work');
mkdirSync(OUT, { recursive: true });
mkdirSync(WORK, { recursive: true });

export const SAMPLES_PER_PROVIDER = statedCount('LINKEDIN_WPROBE_SAMPLES', 'how many sticky sessions are probed from each rotating pool');
export const TARGET_CC = (process.env.LINKEDIN_WPROBE_COUNTRY || 'us').toLowerCase();
export const SUBMIT_CANDIDATE = process.env.LINKEDIN_WPROBE_SUBMIT === '1';
export const STOP_AFTER_SUBMIT = process.env.LINKEDIN_WPROBE_STOP_AFTER_SUBMIT !== '0';
export const PROBE_OS = process.env.LINKEDIN_WPROBE_OS || 'windows';
// Which rotating pools to sample: `provider[/type]` entries.
export const INCLUDE_TEXT = process.env.LINKEDIN_WPROBE_INCLUDE || 'oxylabs/mobile,oxylabs/residential,packetstream,brightdata';
export const INCLUDE = parseInclude(INCLUDE_TEXT);
