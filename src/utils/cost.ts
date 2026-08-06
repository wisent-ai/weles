/**
 * Per-trajectory cost tracker.
 *
 * Thin wrapper around @wisent/cost-tracker — the canonical pricing table
 * and CostTracker class live there. This module preserves weles's original
 * exit/file-flush behaviour so worker/poll.ts keeps reading
 * `recordings/_costs/<ACTION_LOG_ID>.json` unchanged. Call sites in
 * captcha/solver.ts, utils/sms.ts, and session/wsession.ts are unmodified.
 *
 * When the launcher provides the exact weles-database configuration, records
 * are also written to Weles's cost_records table at flush time. When absent,
 * only the local file is written.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CostTracker as SharedCostTracker,
  PRICES as SHARED_PRICES,
  SupabaseSink,
} from '@wisent/cost-tracker';
import { recordCaptchaSolved } from '../captcha/events.js';
import { optionalWelesDatabase } from './weles-database.js';

// Re-export the canonical PRICES table for any in-repo code that read it.
export const PRICES = SHARED_PRICES;

function round4(n: number): number { return Math.round(n * 10000) / 10000; }

class WelesCostTracker {
  private inner: SharedCostTracker;
  private agent_id: string;

  private _databaseUrl: string | null = null;
  private _databaseToken: string | null = null;
  private _autoCreatedRow: boolean = false;

  constructor() {
    const databaseUrl = optionalWelesDatabase()?.url;
    const databaseToken = optionalWelesDatabase()?.token;
    const agent_id = process.env.ACTION_LOG_ID ?? `weles-${process.pid}`;
    this.agent_id = agent_id;
    if (databaseUrl && databaseToken) { this._databaseUrl = databaseUrl; this._databaseToken = databaseToken; }
    // We use a memory sink internally and add Weles database persistence
    // in flush(); this writes the legacy recordings/_costs file and
    // the central table in one operation.
    this.inner = new SharedCostTracker({
      agent_id,
      reference_id: process.env.ACTION_LOG_ID,
      sink: 'memory',
      autoFlush: false,
    });
    // Save exact Weles database config for flush(). Local-only development
    // still writes the local file when launcher configuration is absent.
    if (databaseUrl && databaseToken) {
      this._databaseSink = new SupabaseSink({ url: databaseUrl, key: databaseToken });
    }
    // Auto-flush on process exit.
    // beforeExit only fires on natural event-loop drain; process.exit(N) skips
    // Trajectories call process.exit(0|1), which skips beforeExit. The exit
    // handler keeps local files complete; remote persistence remains on the
    // asynchronous beforeExit/signal paths.
    process.on('exit', () => { try { this.flushLocalSync(); } catch {} });
    process.on('beforeExit', () => { void this.flush(); });
    process.on('SIGINT', () => { void this.flush().finally(() => process.exit(130)); });
    process.on('SIGTERM', () => { void this.flush().finally(() => process.exit(143)); });
  }

  private _databaseSink: SupabaseSink | null = null;

  // Legacy weles API surface — call sites in solver.ts, sms.ts, wsession.ts
  // expect these exact method shapes.
  record(service: string, usd: number): void {
    if (!service || !Number.isFinite(usd) || usd <= 0) return;
    this.inner.record({ service, usage_type: 'units', usage_amount: 1, cost_usd: usd });
  }

  recordCaptcha(service: keyof typeof SHARED_PRICES.captcha, taskType: string, override?: number): void {
    this.inner.recordCaptcha(String(service), taskType, override);
    // G8: mirror every successful solve into the per-run captcha event log
    // (additive — does not affect cost accounting). Resolve the cost the same
    // way the pricing table does so the event carries the real cost_usd.
    try {
      const table = (SHARED_PRICES.captcha as Record<string, Record<string, number>>)[String(service)] ?? {};
      const cost = override ?? table[taskType] ?? table.default ?? 0;
      recordCaptchaSolved(String(service), taskType, cost);
    } catch { /* best-effort: never break cost tracking */ }
  }

  recordSms(provider: 'juicysms' | 'smsactivate', service: string, override?: number): void {
    this.inner.recordSms(provider, service, override);
  }

  recordProxyBytes(provider: string, bytes: number, isMobile = false): void {
    if (!provider || bytes <= 0) return;
    this.inner.recordProxyBytes(provider, bytes, isMobile);
  }

  recordLlm(model: string, inputTokens: number, outputTokens: number, override?: number): void {
    this.inner.recordLlm(model, inputTokens, outputTokens, override);
  }

  total(): number { return this.inner.total(); }

  snapshot(): { cost_usd: number; service_costs: Record<string, number> } {
    const s = this.inner.snapshot();
    return { cost_usd: s.cost_usd, service_costs: s.service_costs };
  }

  /** Writes recordings/_costs/<ACTION_LOG_ID>.json (legacy worker contract)
   *  AND, if Supabase creds are set, posts records to cost_records.
   *  NOT idempotent — each call drains the buffer so multiple WSession
   *  close() calls in one trajectory all get their records written. */
  async flush(): Promise<void> {
    const snap = this.inner.snapshot();
    if (snap.records.length === 0) return;
    // Clear the inner buffer so subsequent flush() calls only write new records.
    (this.inner as any).buffer = [];

    const id = process.env.ACTION_LOG_ID;
    // Accumulate into the local file so the worker sees the full total.
    if (id) {
      const path = join(process.cwd(), 'recordings', '_costs', `${id}.json`);
      try {
        await mkdir(dirname(path), { recursive: true });
        // Read existing file to merge, so multiple flushes produce a single
        // rollup (worker reads the file once at the end).
        let existing: { cost_usd: number; service_costs: Record<string, number> } = { cost_usd: 0, service_costs: {} };
        try { existing = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8')); } catch { /* first flush */ }
        for (const [k, v] of Object.entries(snap.service_costs)) {
          existing.service_costs[k] = round4((existing.service_costs[k] ?? 0) + v);
        }
        existing.cost_usd = round4(existing.cost_usd + snap.cost_usd);
        await writeFile(path, JSON.stringify(existing));
      } catch { /* best-effort */ }
    }

    if (this._databaseSink) {
      // Auto-attach to an account_action_logs row before writing cost_records,
      // so every record ties to a budget row. Without this, ad-hoc weles
      // invocations (no ACTION_LOG_ID env) end up as 'weles-<pid>' agents
      // that float in cost_records with no FK back to a trajectory row.
      // Discovered 2026-05-02 audit: 42% of tracked proxy egress today (635MB)
      // was from these untraceable agents.
      await this.ensureActionLogRow();
      try {
        const stamped = snap.records.map(r => ({ ...r, agent_id: this.agent_id })) as any;
        await this._databaseSink.write(stamped);
      } catch (e: any) {
        const msg = String(e?.message || e);
        if (/PGRST205|cost_records/.test(msg)) {
          console.log('[cost] cost_records table not found in schema; disabling Weles database sink for this process');
          this._databaseSink = null;
        } else {
          console.log(`[cost] Weles database flush err: ${msg.slice(0, 120)}`);
        }
      }
      // If we created the action_log row ourselves, also patch it with the
      // running cost_usd + service_costs so the budget query against
      // account_action_logs sees the spend without needing a cost_records join.
      if (this._autoCreatedRow) await this.patchActionLogRow(snap);
    }
  }

  /** If no ACTION_LOG_ID was provided by the caller, INSERT a placeholder row
   *  into account_action_logs so cost_records have an FK to attach to. The row
   *  uses action='unattributed:<label>' and the first active social_account as
   *  FK placeholder (account_id is NOT NULL). After this, this.agent_id is
   *  the new row's UUID and process.env.ACTION_LOG_ID is set so subsequent
   *  modules (worker poll readCosts, file flush path) align. */
  private async ensureActionLogRow(): Promise<void> {
    if (this._autoCreatedRow) return;
    if (process.env.ACTION_LOG_ID) return; // caller anchored us already
    if (!this._databaseUrl || !this._databaseToken) return;
    const headers = { apikey: this._databaseToken, Authorization: `Bearer ${this._databaseToken}`, 'Content-Type': 'application/json' };
    try {
      const probe = await fetch(`${this._databaseUrl}/rest/v1/social_accounts?is_active=eq.true&select=id,platform&limit=1`, { headers });
      const accts = await probe.json() as Array<{ id: string; platform: string }>;
      if (!Array.isArray(accts) || accts.length === 0) return;
      const label = process.env.WSESSION_LABEL ?? process.env.npm_package_name ?? `pid-${process.pid}`;
      const ins = await fetch(`${this._databaseUrl}/rest/v1/account_action_logs`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify({
          account_id: accts[0].id,
          platform: accts[0].platform,
          action: `unattributed:${label}`,
          status: 'in_progress',
          started_at: new Date().toISOString(),
          claimed_by: `weles-${process.pid}`,
          params: { reason: 'auto-created by cost.ts (no ACTION_LOG_ID env)' },
        }),
      });
      const rows = await ins.json() as Array<{ id: string }>;
      const id = rows?.[0]?.id;
      if (id) {
        this.agent_id = id;
        process.env.ACTION_LOG_ID = id;
        (this.inner as any).agent_id = id;
        this._autoCreatedRow = true;
        console.log(`[cost] auto-created account_action_logs row ${id} (label=${label})`);
      }
    } catch (e: any) { console.log(`[cost] ensureActionLogRow err: ${e.message?.slice(0, 120)}`); }
  }

  /** PATCH the auto-created account_action_logs row with the running cost
   *  rollup. Done after every flush so the budget query sees current spend. */
  private async patchActionLogRow(snap: { cost_usd: number; service_costs: Record<string, number> }): Promise<void> {
    if (!this._databaseUrl || !this._databaseToken) return;
    const headers = { apikey: this._databaseToken, Authorization: `Bearer ${this._databaseToken}`, 'Content-Type': 'application/json' };
    try {
      const r = await fetch(`${this._databaseUrl}/rest/v1/account_action_logs?id=eq.${this.agent_id}&select=cost_usd,service_costs`, { headers });
      const cur = (await r.json() as Array<{ cost_usd: number | null; service_costs: Record<string, number> | null }>)[0] ?? { cost_usd: 0, service_costs: {} };
      const merged: Record<string, number> = { ...(cur.service_costs ?? {}) };
      for (const [k, v] of Object.entries(snap.service_costs)) merged[k] = round4((merged[k] ?? 0) + v);
      const newTotal = round4(Number(cur.cost_usd ?? 0) + snap.cost_usd);
      await fetch(`${this._databaseUrl}/rest/v1/account_action_logs?id=eq.${this.agent_id}`, {
        method: 'PATCH', headers, body: JSON.stringify({ cost_usd: newTotal, service_costs: merged }),
      });
    } catch (e: any) { console.log(`[cost] patchActionLogRow err: ${e.message?.slice(0, 120)}`); }
  }

  /** Synchronous local-file flush for the 'exit' handler.
   *  process.exit(N) skips beforeExit, so the async flush() above never runs
   *  on the trajectory's normal exit paths. This drains the buffer to
   *  recordings/_costs/<id>.json so the worker's readCosts() in poll.ts gets
   *  the per-trajectory rollup. Supabase writes are async and skipped here. */
  flushLocalSync(): void {
    const snap = this.inner.snapshot();
    if (snap.records.length === 0) return;
    (this.inner as any).buffer = [];
    const id = process.env.ACTION_LOG_ID;
    if (!id) return;
    const path = join(process.cwd(), 'recordings', '_costs', `${id}.json`);
    mkdirSync(dirname(path), { recursive: true });
    let existing: { cost_usd: number; service_costs: Record<string, number> } = { cost_usd: 0, service_costs: {} };
    try { existing = JSON.parse(readFileSync(path, 'utf8')); } catch { /* first flush */ }
    for (const [k, v] of Object.entries(snap.service_costs)) {
      existing.service_costs[k] = round4((existing.service_costs[k] ?? 0) + v);
    }
    existing.cost_usd = round4(existing.cost_usd + snap.cost_usd);
    writeFileSync(path, JSON.stringify(existing));
  }
}

export const costTracker = new WelesCostTracker();
