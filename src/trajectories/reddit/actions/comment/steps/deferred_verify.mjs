import { probeCommentVisibility, probeShadowban } from '../../../../../../dist/platforms/reddit/shadowban_probe.js';
import { findAccount, updateAccountMetadata } from '../../../../_shared/skarbiec/accounts.mjs';

/**
 * Deferred clean-session verify. The in-session permalink read catches
 * AutoMod-removal and immediate shadowbans. It does NOT catch Reddit's async
 * spam classifier, which removes the specific comment or shadowbans the
 * account minutes after submit. So a run does not sit and wait for it:
 * every comment run records the comment it posted in the account's metadata
 * (`pending_comment_verify`), and the next comment run on that account first
 * re-fetches that comment through a fresh proxy with NO cookies. If the
 * comment is missing from the clean view, the classifier removed it post-hoc —
 * the account is flagged and the run throws an error carrying the ban signal.
 *
 * Without a captured comment id the multi-vantage account probe stands in:
 * if the WHOLE account is shadowbanned, the user-level check catches it.
 */
export function recordCommentForVerify(acct, { resolvedOldUrl, postedCommentId, handle }) {
  const vaultAccount = findAccount('reddit', acct.username);
  if (!vaultAccount) throw new Error(`deferred verify: reddit account ${acct.username} is not in Skarbiec, so the posted comment cannot be recorded for verification`);
  updateAccountMetadata(vaultAccount.id, {
    pending_comment_verify: {
      post_url: resolvedOldUrl || null,
      comment_id: postedCommentId || null,
      handle: handle || null,
      posted_at: new Date().toISOString(),
    },
  });
  console.log(`[deferred-verify] recorded comment ${postedCommentId || '(no id)'} for the next run's clean-session probe`);
}

export async function verifyPreviousComment(acct) {
  const vaultAccount = findAccount('reddit', acct.username);
  const pending = vaultAccount?.metadata?.pending_comment_verify;
  if (!pending) return;
  const { post_url: postUrl, comment_id: commentId, handle, posted_at: postedAt } = pending;
  let stillPublic = 'unprobed';
  if (commentId && postUrl) {
    const probe = await probeCommentVisibility({
      postPermalinkBase: postUrl,
      commentId,
      expectedAuthor: handle || undefined,
    });
    stillPublic = probe.visible;
    console.log(`[deferred-verify] permalink probe of ${commentId} posted ${postedAt}: visible=${probe.visible} status=${probe.status} exit_ip=${probe.exit_ip ?? '?'}`);
  }
  if (stillPublic === 'unprobed' && handle) {
    const probe = await probeShadowban(handle, 3);
    console.log(`[deferred-verify] account probe: verdict=${probe.verdict}`);
    stillPublic = probe.verdict !== 'shadowbanned';
  }
  updateAccountMetadata(vaultAccount.id, (metadata) => {
    const { pending_comment_verify: _verified, ...rest } = metadata ?? {};
    return rest;
  });
  if (stillPublic === false) {
    updateAccountMetadata(vaultAccount.id, { status: 'shadowbanned', active: false });
    console.log(`[deferred-verify] auto-flagged ${acct.username} status=shadowbanned`);
    const error = new Error(`deferred clean-session probe: the comment posted at ${postedAt} was removed afterwards`);
    error.banSignal = {
      signal: 'shadowbanned',
      healthy: false,
      details: {
        real_handle: handle,
        reason: `comment posted at ${postedAt} was publicly visible right after submit, but missing from a later clean-session probe — async classifier shadowban`,
      },
    };
    throw error;
  }
  console.log(`[deferred-verify] comment posted at ${postedAt} still visible from a clean session`);
}
