import { probeCommentVisibility, probeShadowban } from '../../../../../../dist/platforms/reddit/shadowban_probe.js';
import { findAccount, updateAccountMetadata } from '../../../../_shared/skarbiec/accounts.mjs';
import { DEFER_VERIFY_MS } from './constants.mjs';

/**
 * Deferred clean-session verify. The in-session permalink poll catches
 * AutoMod-removal and immediate shadowbans. It does NOT catch Reddit's async
 * spam classifier, which runs on a 60-300s delay and either removes the
 * specific comment or shadowbans the account without a word. Wait
 * DEFER_VERIFY_MS, then re-fetch the comment permalink JSON via a fresh proxy
 * with NO cookies. If the comment is missing from a clean view, the async
 * classifier removed it post-hoc — flag the account and throw an error that
 * carries the ban signal.
 *
 * Without a captured comment id the multi-vantage account probe stands in:
 * if the WHOLE account is shadowbanned, the user-level check catches it.
 */
export async function deferredCleanSessionVerify({ acct, resolvedOldUrl, postedCommentId, handle }) {
  const seconds = Math.round(DEFER_VERIFY_MS / 1000);
  console.log(`[deferred-verify] waiting ${seconds}s before clean-session probe`);
  await new Promise((r) => setTimeout(r, DEFER_VERIFY_MS));
  let stillPublic = 'unprobed';
  if (postedCommentId) {
    const probe = await probeCommentVisibility({
      postPermalinkBase: resolvedOldUrl,
      commentId: postedCommentId,
      expectedAuthor: handle || undefined,
    });
    stillPublic = probe.visible;
    console.log(`[deferred-verify] permalink probe: visible=${probe.visible} status=${probe.status} exit_ip=${probe.exit_ip ?? '?'}`);
  }
  if (stillPublic === 'unprobed' && handle) {
    try {
      const probe = await probeShadowban(handle, 3);
      console.log(`[deferred-verify] account probe: verdict=${probe.verdict}`);
      stillPublic = probe.verdict !== 'shadowbanned';
    } catch (e) {
      console.log(`[deferred-verify] account probe failed: ${e.message?.slice(0, 120)}`);
    }
  }
  if (stillPublic === false) {
    const vaultAccount = findAccount('reddit', acct.username);
    if (vaultAccount) {
      updateAccountMetadata(vaultAccount.id, { status: 'shadowbanned', active: false });
      console.log(`[deferred-verify] auto-flagged ${acct.username} status=shadowbanned`);
    }
    const error = new Error(`deferred clean-session probe: comment removed within ${seconds}s of submit`);
    error.banSignal = {
      signal: 'shadowbanned',
      healthy: false,
      details: {
        real_handle: handle,
        reason: `comment was publicly visible immediately after submit, but missing from a clean-session probe ${seconds}s later — async classifier shadowban`,
      },
    };
    throw error;
  }
  console.log(`PASS: comment confirmed visible from clean session at t+${seconds}s`);
}
