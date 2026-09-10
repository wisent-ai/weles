/**
 * What this run recorded about itself. Two kinds of evidence live here:
 *
 *  - session_meta.json — the per-run provenance envelope, written once before
 *    the browser exists (so a pre-launch failure still leaves a queryable row)
 *    and once more with the realized values after launch.
 *  - per-step artifacts — the screenshot and DOM dump WSession.runStep takes
 *    around every step, plus a named record of any artifact that could not be
 *    written. A missing screenshot never aborts the step it belongs to, but it
 *    never disappears either: the reason lands in the run log, on the session
 *    as stepArtifactFailures, and in step_artifact_failures.json next to the
 *    artifacts it was supposed to join.
 *
 * Extracted from wsession.ts (env snapshots, the two session_meta writers and
 * WSession._saveDom) to keep the class file under its 300-line cap.
 */

import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Persona } from '../../browser/persona.js';
import type { Identity } from '../../utils/identity/identity.js';
import type { ExitReputation } from '../../proxy/policy.js';
import { snapshotSanitizedEnvironment } from '../../utils/sanitize-env.js';
import type { WSession } from '../wsession.js';
import { runRecordingsDir, runRecordingsRoot } from '../run-recordings.js';
import type { SessionProxy } from './session-request.js';

// G17: artifacts live under recordings/<run_uuid>/<label-or-action>/ — keyed by
// the account_action_logs row id (ACTION_LOG_ID) so they map to the run 1:1.
function recordingsDir(label?: string): string { return label ? runRecordingsDir(label) : runRecordingsRoot(); }

// resolveProxy attaches pool bookkeeping (provider, sticky ids, exit
// reputation) beyond the launch-option shape async_api declares, and the
// exit-IP probe fills exit_ip in place after launch. This is the provenance
// view of that same object; the fields are read, never required.
interface ProxyProvenanceView {
  server?: string;
  username?: string;
  exit_ip?: string;
  platform?: string;
  provider?: string;
  sticky_session_id?: string;
  sticky_hash?: string;
  exit_reputation?: ExitReputation;
}

// G2: effective behavior-changing env vars snapshotted at session start. The
// list is intentionally generous — any flag that alters input path, browser
// selection/registration, instrumentation, recording, diagnostics, LinkedIn
// egress policy, or proxy-pool wiring. Reads process.env directly so the value
// reflects the live process at session start; unset flags surface as undefined.
const ENV_FLAG_KEYS = [
  'WELES_INPUT', 'WELES_INSTANT_INPUT', 'WELES_REGISTER_BROWSER',
  'WELES_ENABLE_CHROME147_STUBS', 'WELES_DISABLE_HTTP2',
  'WELES_NO_INSTRUMENT', 'WELES_FULL_DIAGNOSTICS', 'WELES_PCAP_DIAGNOSTICS',
  'WELES_DISABLE_RECORDING', 'WELES_ALLOW_LINKEDIN_DIRECT', 'WELES_ALLOW_LINKEDIN_RESIDENTIAL',
  'WELES_ALLOW_LINKEDIN_UNDECLARED_PROXY', 'LINKEDIN_REGISTER_PREWARM_URLS',
  'DECODO_ISP_PORTS', 'DECODO_ISP_PORT', 'DECODO_ISP_HOST',
  'WELES_FORCE_PROXY',
  'WELES_CAPTURE_RESPONSE_BODIES', 'WELES_HOST_DIAGNOSTICS', 'WELES_STORAGE_DIAGNOSTICS',
  'WELES_CDP_DIAGNOSTICS', 'WELES_CDP_FIREHOSE', 'WELES_CHROMIUM_NETLOG',
  'WELES_PROXY_DIAGNOSTICS_LABEL', 'WELES_NOPECHA_EXT', 'WELES_USER_DATA_DIR',
  'WELES_BROWSER_PROFILE_ROOT', 'WELES_CACHE_DIR', 'WELES_CHROMIUM_PROFILE_DIRECTORY',
  'WELES_USE_NATIVE_KEYCHAIN',
] as const;
export function snapshotEnvFlags(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of ENV_FLAG_KEYS) out[k] = process.env[k];
  return out;
}

export function hashDiagnosticValue(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export interface SessionMetaRequest {
  label: string;
  persona: Persona;
  proxy: SessionProxy | undefined;
  proxyRequested: unknown;
  timingSeed: number;
}

export interface RealizedSessionMeta extends SessionMetaRequest {
  realizedFingerprint: Record<string, unknown>;
  browserProvenance: unknown;
  identity: Identity | undefined;
}

// G19: shared per-run provenance writer — called EARLY (pre-launch) and again
// AFTER launch with the realized values. The early call guarantees that a
// pre-launch failure (proxy_unavailable, missing browser binary, launch
// crash) still leaves queryable provenance — persona, the proxy request and
// its resolution, the env snapshot, timing seed — instead of a black-hole row
// the diagnostics platform can't explain. realized_fingerprint / exit_ip /
// identity are null until the browser is up; the late call fills them in.
// Both writers keep the same key set so early and late writes can't drift on
// the keys the worker importer reads. session_meta lands in the ACTION dir
// (poll.ts imports + uploads from there), or under label for standalone runs.
export function writePrelaunchSessionMeta(request: SessionMetaRequest): void {
  if (!request.label) return;
  try {
    const proxyObj = request.proxy as ProxyProvenanceView | undefined;
    const pu = proxyObj?.server ? new URL(proxyObj.server) : null;
    const meta = {
      proxy_host: pu?.hostname, proxy_port: pu?.port,
      proxy_user_present: !!proxyObj?.username, proxy_user_hash: hashDiagnosticValue(proxyObj?.username),
      exit_ip: proxyObj?.exit_ip, platform: proxyObj?.platform, provider: proxyObj?.provider,
      browser_provenance: null, persona: request.persona, realized_fingerprint: null,
      proxy_requested: request.proxyRequested ?? null,
      env_flags: snapshotEnvFlags(), env_all: snapshotSanitizedEnvironment(),
      sticky_session_id: proxyObj?.sticky_session_id, sticky_hash: proxyObj?.sticky_hash,
      exit_reputation: proxyObj?.exit_reputation, identity: undefined,
      timing_seed: request.timingSeed, started_at: new Date().toISOString(),
    };
    writeFileSync(join(recordingsDir(process.env.ACTION || request.label), 'session_meta.json'), JSON.stringify(meta, null, 2));
  } catch { /* provenance is best-effort */ }
}

// G14: write provenance for EVERY labelled run, proxied or not. The whole
// block used to be gated on the proxy server being set, so direct (no-proxy)
// browser runs recorded none of it. Proxy-derived fields are now optional.
export function writeRealizedSessionMeta(realized: RealizedSessionMeta): void {
  if (!realized.label) return;
  try {
    const proxyObj = realized.proxy as ProxyProvenanceView | undefined;
    const u = proxyObj?.server ? new URL(proxyObj.server) : null;
    // Full per-run fingerprint provenance (G1): the randomized source
    // persona AND the realized fingerprint actually presented (UA, full
    // UA-CH brand list, navigator/screen/webgl), copied verbatim into
    // account_action_logs.result.session by the worker importer.
    // persona + realized_fingerprint are typed REQUIRED + non-null so a
    // future edit cannot silently drop them to null: persona is always
    // generated, and async_api always attaches a realized fingerprint.
    const meta: {
      proxy_host?: string; proxy_port?: string; proxy_user_present: boolean;
      proxy_user_hash: unknown; exit_ip: unknown; platform: unknown; provider: unknown;
      browser_provenance: unknown; persona: Persona; realized_fingerprint: Record<string, unknown>;
      proxy_requested: unknown;
      env_flags: Record<string, string | undefined>;
      env_all: Record<string, string>;
      sticky_session_id?: string; sticky_hash?: string;
      exit_reputation?: ExitReputation;
      identity?: Identity;
      timing_seed: number;
      started_at: string;
    } = {
      proxy_host: u?.hostname,
      proxy_port: u?.port,
      proxy_user_present: !!proxyObj?.username,
      proxy_user_hash: hashDiagnosticValue(proxyObj?.username),
      exit_ip: proxyObj?.exit_ip,
      platform: proxyObj?.platform,
      provider: proxyObj?.provider,
      browser_provenance: realized.browserProvenance,
      persona: realized.persona,
      realized_fingerprint: realized.realizedFingerprint,
      proxy_requested: realized.proxyRequested ?? null,
      // G2: snapshot the effective behavior-changing env vars at session
      // start so a run's exact mode (input path, browser registration,
      // diagnostics, LinkedIn egress policy, proxy pool wiring) is queryable.
      // Required Record (never null); individual flags are undefined when
      // unset — that absence is itself meaningful provenance.
      env_flags: snapshotEnvFlags(),
      // G15: the COMPLETE runner env (all keys), secret values redacted.
      env_all: snapshotSanitizedEnvironment(),
      // G4: which sticky exit this session pinned to. Undefined for
      // non-sticky / url-form proxies (legitimately — only sticky-capable
      // providers populate it), so it is NOT forced non-null.
      sticky_session_id: proxyObj?.sticky_session_id,
      sticky_hash: proxyObj?.sticky_hash,
      // G11: full ip-api enrichment of the winning exit IP (ASN, ISP/org,
      // reverse-DNS, region/city/geo, proxy/hosting/mobile flags). Optional
      // — ip-api can fail or the run may have no exit IP.
      exit_reputation: proxyObj?.exit_reputation,
      // G6: full raw generated identity (first/last/username/email/password/
      // DOB) for EVERY run that has one — not just register. Raw values in
      // the row are explicitly approved. Present whenever a platform was
      // given (ws.identity is generated then); session_meta.json doubles as
      // the storage backup for non-register runs that never call saveAccount.
      identity: realized.identity,
      // G9: per-run human-timing seed (required non-null) — makes this run's
      // mouse/typing jitter reproducible from the row.
      timing_seed: realized.timingSeed,
      started_at: new Date().toISOString(),
    };
    // G12: write provenance into the worker's ACTION dir (set by poll.ts on
    // every spawned trajectory) so it lands where poll.ts imports + uploads
    // from — even when this WSession's label differs from the dispatch action
    // (health _in/_out, register _<attempt>, reddit submit, ticker scrapers).
    // Uses label for standalone (non-worker) runs.
    writeFileSync(join(recordingsDir(process.env.ACTION || realized.label), 'session_meta.json'), JSON.stringify(meta, null, 2));
  } catch {}
}

export type StepPhase = 'before' | 'after' | 'error';

/** An artifact the step was supposed to leave behind, and why it is missing. */
export interface StepArtifactFailure {
  step: string;
  phase: StepPhase;
  artifact: 'screenshot' | 'dom';
  reason: string;
  at: string;
}

/**
 * Take the screenshot + DOM dump for one step phase. Neither artifact aborts
 * the step: an artifact that could not be written is recorded by name instead.
 * `cause` carries the step's own failure in the 'error' phase, so a recorder
 * that cannot even write its ledger reports both failures rather than
 * replacing the one the caller is about to throw.
 */
export async function captureStepArtifacts(ws: WSession, phase: StepPhase, step: string, cause?: unknown): Promise<void> {
  const at = new Date().toISOString();
  const failures: StepArtifactFailure[] = [];
  // The capture surface is private to WSession; this is the same session
  // object, viewed through the one member this recorder needs.
  const capture = ws as unknown as { _cap: { screenshot(page: unknown, label: string): Promise<string> } };
  try {
    await capture._cap.screenshot(ws.page, `${phase}_${step}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    failures.push({ step, phase, artifact: 'screenshot', reason: `the ${phase} screenshot could not be taken: ${reason}`, at });
  }
  try {
    const html = await ws.page.content?.();
    if (html) writeFileSync(join(recordingsDir(ws.label || undefined), `${phase}_${step}_dom.html`), html);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    failures.push({ step, phase, artifact: 'dom', reason: `the ${phase} DOM dump could not be written: ${reason}`, at });
  }
  if (failures.length === 0) return;
  for (const failure of failures) console.log(`[wsession] ${step} ARTIFACT MISSING ${failure.artifact} — ${failure.reason.slice(0, 300)}`);
  ws.stepArtifactFailures.push(...failures);
  try {
    writeFileSync(
      join(recordingsDir(ws.label || undefined), 'step_artifact_failures.json'),
      JSON.stringify(ws.stepArtifactFailures, null, 2),
    );
  } catch (ledgerError) {
    const ledgerReason = ledgerError instanceof Error ? ledgerError.message : String(ledgerError);
    if (cause !== undefined) {
      const stepReason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `step ${step} failed and its missing-artifact record could not be written: ${stepReason}; and the record write failed: ${ledgerReason}`,
        { cause },
      );
    }
    throw ledgerError;
  }
}
