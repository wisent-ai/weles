// The environment the Overleaf pull runs with: the project and the linked repository that
// disambiguates it, the DOM dumps beside the run's recordings, the auth label and the
// persistent Overleaf browser profile shared by every Overleaf trajectory.
import { mkdirSync } from 'node:fs';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';

export let PROJECT = process.argv[2];
if (!PROJECT) PROJECT = process.env.OVERLEAF_PROJECT;
export let REPO_SLUG = process.argv[3];
if (!REPO_SLUG) REPO_SLUG = process.env.OVERLEAF_GITHUB_REPO;
if (!PROJECT || !REPO_SLUG) {
  console.error('FAIL: need <PROJECT> <REPO_SLUG>. PROJECT=24-hex id or title substring; REPO_SLUG=owner/name of the linked GitHub repo (the disambiguator).');
  process.exit(1);
}
export const IS_ID = /^[0-9a-fA-F]{24}$/.test(PROJECT);
export const REPO_LC = REPO_SLUG.toLowerCase();

export const SHOT_DIR = runRecordingsDir('overleaf_pull_github');
export const OVERLEAF_AUTH_LABEL = process.env.OVERLEAF_AUTH_LABEL || 'overleaf';
export const OVERLEAF_PROFILE_DIR = `${process.env.HOME}/Documents/CodingProjects/Wisent/weles/.work/overleaf_browser_profile`;
if (process.env.WELES_OVERLEAF_PERSISTENT_PROFILE !== '0' && !process.env.WELES_USER_DATA_DIR) {
  mkdirSync(OVERLEAF_PROFILE_DIR, { recursive: true });
  process.env.WELES_USER_DATA_DIR = OVERLEAF_PROFILE_DIR;
  console.log(`[pull_github] using persistent Overleaf browser profile: ${OVERLEAF_PROFILE_DIR}`);
}
