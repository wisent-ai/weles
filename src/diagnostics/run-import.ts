// Shared run-diagnostics: import the per-run provenance envelope and persist the
// full network capture. Used by BOTH the worker (poll.ts, for queued trajectory
// jobs) and the keeper (scripts/_shared/keeper/bookkeeping.mjs, for persistent
// sessions) so the two paths can never drift — especially writeNetworkCapture,
// whose ::text::jsonb cast + U+0000/surrogate sanitization are easy to get wrong.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { analyzeChallengeOutcome, type ChallengeOutcome } from './challenge_outcome.js';

const RECORDINGS_ROOT = process.env.RECORDINGS_ROOT ?? 'recordings';
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';

// Artifacts live under recordings/<run_uuid>/ across varying sub-action/label
// dirs. Find a file by name anywhere in the run's tree.
async function findInRun(runId: string, filename: string): Promise<string | null> {
  async function walk(dir: string): Promise<string | null> {
    let entries: any[];
    try { entries = (await readdir(dir, { withFileTypes: true } as any)) as any; } catch { return null; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { const r = await walk(full); if (r) return r; }
      else if (e.name === filename) return full;
    }
    return null;
  }
  return walk(join(RECORDINGS_ROOT, runId));
}
async function readJsonInRun(runId: string, filename: string): Promise<any | null> {
  const p = await findInRun(runId, filename);
  if (!p) return null;
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}

export interface RunProvenance {
  session?: Record<string, unknown>;
  identity?: unknown;
  run?: { timing_seed: number };
  challenge_outcome?: ChallengeOutcome;
}

// Decode the captcha/challenge outcome (type, grid, objects, verdicts, whether
// LinkedIn accepted) from the run's HAR — the only artifact that carries the
// reCAPTCHA response bodies. Best-effort; null when no HAR or no challenge.
export async function readChallengeOutcome(runId: string): Promise<ChallengeOutcome | null> {
  const har = await readJsonInRun(runId, 'session.har');
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) return null;
  try {
    const co = analyzeChallengeOutcome(entries);
    return co.present ? co : null;
  } catch { return null; }
}

// Build the rich result.session (+ identity + run) from session_meta.json /
// proxy_preflight.json written by WSession. Falls back to a meta_missing
// envelope (requested proxy + full env) when the run died before any session
// existed — so a run is never a black hole. Mirrors the worker importer exactly.
export async function importRunProvenance(runId: string, params?: Record<string, unknown>): Promise<RunProvenance> {
  const out: RunProvenance = {};
  const m = await readJsonInRun(runId, 'session_meta.json');
  if (m) {
    out.session = {
      proxy_host: m.proxy_host, proxy_port: m.proxy_port,
      proxy_user_present: !!m.proxy_user_present, proxy_user_hash: m.proxy_user_hash ?? null,
      exit_ip: m.exit_ip, platform: m.platform, provider: m.provider,
      browser_provenance: m.browser_provenance,
      persona: m.persona, realized_fingerprint: m.realized_fingerprint,
      proxy_requested: m.proxy_requested,
      env_flags: m.env_flags, env_all: m.env_all,
      sticky_session_id: m.sticky_session_id, sticky_hash: m.sticky_hash,
      exit_reputation: m.exit_reputation,
    };
    if (m.identity) out.identity = m.identity;
    if (typeof m.timing_seed === 'number') out.run = { timing_seed: m.timing_seed };
  } else {
    const envAll: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') envAll[k] = v;
    out.session = {
      meta_missing: true,
      proxy_requested: (params as Record<string, unknown> | undefined)?.proxy_url_override ?? null,
      env_all: envAll,
    };
  }
  const pf = await readJsonInRun(runId, 'proxy_preflight.json');
  if (pf) {
    if (out.session) (out.session as Record<string, unknown>).proxy_preflight = pf;
    else out.session = { proxy_preflight: pf };
  }
  const rc = await readJsonInRun(runId, 'real_chrome_session.json');
  if (rc) {
    if (out.session) (out.session as Record<string, unknown>).real_chrome = rc;
    else out.session = { real_chrome: rc };
  }
  const co = await readChallengeOutcome(runId);
  if (co) out.challenge_outcome = co;
  return out;
}

// Direct Postgres connection string for the heavy network-capture write. Returns
// null (write skipped) when no DB password is configured. PREFER SUPABASE_DB_URL:
// the Supavisor pooler host prefix (aws-0 / aws-1 / …) is assigned per-project
// and is NOT derivable from the ref, so the reconstructed fallback can target the
// wrong cluster ("Tenant or user not found"). SUPABASE_DB_REGION overrides it.
export function pgConnectionString(): string | null {
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL;
  const pw = process.env.SUPABASE_DB_PASSWORD;
  const ref = SUPABASE_URL.match(/https?:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
  if (!pw || !ref) return null;
  const region = process.env.SUPABASE_DB_REGION ?? 'aws-1-us-east-1';
  return `postgresql://postgres.${ref}:${encodeURIComponent(pw)}@${region}.pooler.supabase.com:5432/postgres?sslmode=require`;
}

// G18: persist the FULL per-run network/instrumentation capture (every
// *.inst.json under the run dir, raw — every request/response with bodies, WS
// frames, TLS, DNS, JS access traps) into account_action_log_capture as a lazy
// jsonb, keyed by run uuid. Direct PG (too large for PostgREST). Best-effort.
export async function writeNetworkCapture(runId: string): Promise<void> {
  const conn = pgConnectionString();
  if (!conn) return;
  const root = join(RECORDINGS_ROOT, runId);
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: any[];
    try { entries = (await readdir(dir, { withFileTypes: true } as any)) as any; } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      // .inst.json = the instrumentation dump; session.har = Playwright's HAR,
      // the ONLY artifact that reliably carries every response body (captured at
      // response time, not via best-effort post-hoc resp.body()). Embed both so
      // the SQL copy is genuinely complete — never a body-less projection.
      else if (e.name.endsWith('.inst.json') || e.name.endsWith('.har')) files.push(full);
    }
  };
  await walk(root);
  if (!files.length) return;
  // Build {"<relpath>": <raw json>, ...} by RAW embedding (no 47MB JS parse);
  // each .inst.json is already valid JSON, so it slots in as a value verbatim.
  const parts: string[] = [];
  let bytes = 0;
  for (const f of files) {
    try { const raw = await readFile(f, 'utf8'); bytes += raw.length; parts.push(`${JSON.stringify(f.slice(root.length + 1))}:${raw}`); } catch { /* skip unreadable */ }
  }
  if (!parts.length) return;
  // Postgres jsonb cannot hold U+0000 nor unpaired UTF-16 surrogates, and
  // captured request/response bodies contain both — a bare ::jsonb cast then
  // dies with 22P05. Neutralize those escapes to U+FFFD before the cast; the
  // pristine bytes still live in storage, this is only the SQL-queryable copy.
  let capture = `{${parts.join(',')}}`;
  capture = capture
    .replace(/\\u0000/gi, '\\uFFFD')
    .replace(/\\u(d[89ab][0-9a-f]{2})(?!\\ud[c-f][0-9a-f]{2})/gi, '\\uFFFD') // lone high surrogate
    .replace(/(?<!\\ud[89ab][0-9a-f]{2})\\u(d[c-f][0-9a-f]{2})/gi, '\\uFFFD'); // lone low surrogate
  const sql = postgres(conn, { prepare: false, max: 1, idle_timeout: 5, connect_timeout: 15 });
  try {
    // NB: ${capture}::text::jsonb, NOT ::jsonb. postgres.js JSON-encodes a JS
    // string before a bare ::jsonb cast (storing it as a jsonb *string*); the
    // ::text step forces it to send the already-JSON text verbatim so the cast
    // yields a jsonb object. Verified against postgres.js 3.4.9.
    await sql`insert into account_action_log_capture (log_id, capture, bytes) values (${runId}, ${capture}::text::jsonb, ${bytes})
              on conflict (log_id) do update set capture = excluded.capture, bytes = excluded.bytes, created_at = now()`;
    console.log(`[capture] ${runId.slice(0, 8)} network capture -> account_action_log_capture (${(bytes / 1e6).toFixed(1)}MB, ${files.length} inst)`);
  } catch (e) {
    console.log(`[capture] network capture write failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 140)}`);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
