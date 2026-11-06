// The account's verdict after an action, and where it is kept. The verdict
// is the platform's own ban detector (proxy failures from Chromium's error
// page, the routes the platform declares, the page as the model judges it,
// the API answers the session saw), read through the shared reader
// (`../auth/ban-signal.mjs`). A healthy verdict on a write action that no
// captured write API call backs is the action failing. The verdict is written
// to the run's ban_signal.json, and a checkpoint marks the account's cookies
// stale so the next run picks another account.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { markCookiesStale } from '../../../../dist/utils/credentials.js';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';
import { banSignalOf, HEALTH_SIGNAL, HEALTH_UNREAD } from '../auth/ban-signal.mjs';

const INDENT = '  ';

/** The verdict once the action returned `resultValue`. */
export async function verdictAfterAction(s, cfg, resultValue) {
  const banSignal = await banSignalOf(cfg.banDetector, s, 'after the action');
  if (!banSignal.healthy) return banSignal;
  const { verifyWriteAction } = await import(
    '../../../../dist/platforms/_shared/write_verify.js'
  );
  const written = verifyWriteAction(
    cfg.platform,
    cfg.action,
    s.capturedResponses,
  );
  if (!written.applicable || written.wrote) return banSignal;
  return {
    signal: 'action_failed',
    healthy: false,
    details: {
      final_url: s.page.url(),
      reason: `the action answered '${resultValue}' but no ${cfg.platform} ${cfg.action} write API call was captured`,
      prev_signal: banSignal.signal,
    },
  };
}

/**
 * The verdict of a run that failed with `error`: a signal already read
 * before the failure, the one the error carries, the detector's reading of
 * the page, or, when the detector could not read it, the failure itself with
 * the unread health beside it.
 */
export async function verdictAfterFailure(s, cfg, error, known) {
  if (known) return known;
  if (error.banSignal) return error.banSignal;
  const detected = await banSignalOf(cfg.banDetector, s, 'after the failure');
  if (detected.signal !== HEALTH_UNREAD) return detected;
  return {
    signal: 'action_failed',
    healthy: false,
    details: {
      final_url: s.page.url(),
      reason: error.message,
      health: detected.details,
    },
  };
}

/**
 * Write the verdict to the run's ban_signal.json, with the `run` fields the
 * caller adds, and, for a checkpoint, mark the account's cookies stale. A run
 * that never found its account records none. Throws when either fails.
 */
export async function keepVerdict(label, acct, banSignal, run = {}) {
  const dir = runRecordingsDir(label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'ban_signal.json'),
    JSON.stringify(
      {
        account_id: acct ? acct.id : null,
        username: acct ? acct.username : null,
        action: label,
        ...run,
        ...banSignal,
        ts: new Date().toISOString(),
      },
      null,
      INDENT,
    ),
  );
  if (banSignal.signal === HEALTH_SIGNAL.checkpoint && acct?.id)
    await markCookiesStale(acct.id);
}
