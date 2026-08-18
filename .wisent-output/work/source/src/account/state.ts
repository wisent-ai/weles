import { optionalWelesDatabase } from '../utils/weles-database.js';

/**
 * Mark a social_accounts row inactive so getSocialAccount stops handing it
 * out. Called by login trajectories when the platform returns a hard ban
 * signal (Discord ACCOUNT_PERMANENTLY_DISABLED, Instagram /accounts/suspended/,
 * LinkedIn checkpoint after multiple retries).
 */
export async function deactivateAccount(
  accountId: string | undefined | null,
  currentMetadata: Record<string, any> | undefined,
  reason: string,
): Promise<void> {
  if (!accountId) return;
  const url = optionalWelesDatabase()?.url ?? '';
  const key = optionalWelesDatabase()?.token ?? '';
  if (!url || !key) return;
  const merged = { ...(currentMetadata ?? {}), banned_reason: reason, banned_at: new Date().toISOString() };
  try {
    await fetch(`${url}/rest/v1/social_accounts?id=eq.${accountId}`, {
      method: 'PATCH',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ is_active: false, metadata: merged }),
    });
    console.log(`[account-state] deactivated ${accountId} (${reason})`);
  } catch (e: any) {
    console.log(`[account-state] deactivate err: ${e?.message?.slice(0, 100)}`);
  }
}
