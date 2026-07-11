// Config-gated startup hook: capture the ASC issuer_id with no human step, by
// enqueuing apple_login (native trusted-device 2FA ASC session refresh) and an
// account-bound issuer read. Idempotent. Disable with WELES_ENSURE_ASC_ISSUER=0.
// Reuses the reviewed DB plumbing from stale.ts; never touches the service key.
import { SUPABASE_URL, headers } from '../stale.js';

const APPLE_ACCOUNT_ID = process.env.ASC_APPLE_ACCOUNT_ID ?? 'ef63f7c7-0d13-47c3-891e-73307c4282a9';
const KEYS_URL = 'https://appstoreconnect.apple.com/access/integrations/api';
const OBJECTIVE = 'Open Users and Access, Integrations, App Store Connect API, Team Keys tab; read the Issuer ID UUID near the top; call done with {"issuer_id":"<uuid>"}; never output keys, tokens, or passwords.';

type ResultRow = { result?: { value?: { issuer_id?: unknown }; issuer_id?: unknown } };
type ParamsRow = { params?: { url?: unknown } };

async function rows(q: string): Promise<unknown[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/account_action_logs?${q}`, { headers: headers() });
  if (!r.ok) throw new Error(`asc-issuer query failed: ${r.status}`);
  return (await r.json()) as unknown[];
}
async function enqueue(row: Record<string, unknown>): Promise<void> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/account_action_logs`, { method: 'POST', headers: { ...headers(), Prefer: 'return=minimal' }, body: JSON.stringify(row) });
  if (!r.ok) throw new Error(`asc-issuer enqueue failed: ${r.status}`);
}
function capturedIssuer(done: ResultRow[]): string | null {
  for (const row of done) {
    const v = row?.result?.value?.issuer_id ?? row?.result?.issuer_id;
    if (typeof v === 'string' && v) return v;
  }
  return null;
}
function issuerReadInFlight(open: ParamsRow[]): boolean {
  for (const row of open) if (row?.params?.url === KEYS_URL) return true;
  return false;
}
export async function ensureAscIssuer(): Promise<void> {
  if (process.env.WELES_ENSURE_ASC_ISSUER === '0' || !SUPABASE_URL) return;
  try {
    const done = (await rows(`select=result&status=eq.completed&action=eq.generic_browser_task&account_id=eq.${APPLE_ACCOUNT_ID}&limit=200`)) as ResultRow[];
    const issuer = capturedIssuer(done);
    if (issuer) { console.log(`[asc-issuer] already captured: ${issuer}`); return; }
    if (!(await rows(`select=id&status=in.(queued,running)&action=eq.apple_login&account_id=eq.${APPLE_ACCOUNT_ID}`)).length)
      await enqueue({ action: 'apple_login', platform: 'apple', account_id: APPLE_ACCOUNT_ID, status: 'queued' });
    const open = (await rows(`select=params&status=in.(queued,running)&action=eq.generic_browser_task&account_id=eq.${APPLE_ACCOUNT_ID}`)) as ParamsRow[];
    if (!issuerReadInFlight(open))
      await enqueue({ action: 'generic_browser_task', platform: 'generic', account_id: APPLE_ACCOUNT_ID, status: 'queued', params: { url: KEYS_URL, objective: OBJECTIVE } });
    console.log('[asc-issuer] ensure pass complete');
  } catch (e) { console.error(`[asc-issuer] deferred: ${e instanceof Error ? e.message : String(e)}`); }
}
