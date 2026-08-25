import { updateAccount } from '../state/skarbiec-records.js';

/** Mark a trajectory account inactive in Skarbiec after a hard ban signal. */
export async function deactivateAccount(
  accountId: string | undefined | null,
  currentMetadata: Record<string, any> | undefined,
  reason: string,
): Promise<void> {
  if (!accountId) return;
  const merged = {
    ...(currentMetadata ?? {}),
    banned_reason: reason,
    banned_at: new Date().toISOString(),
  };
  try {
    updateAccount(accountId, { active: false, metadata: merged });
    console.log(`[account-state] deactivated ${accountId} (${reason})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[account-state] deactivate err: ${message.slice(0, 100)}`);
  }
}
