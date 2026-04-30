/**
 * Per-trajectory cost tracker.
 *
 * Thin wrapper around @wisent/cost-tracker — the canonical pricing table
 * and CostTracker class live there. This module preserves weles's original
 * exit/file-flush behaviour so worker/poll.ts keeps reading
 * `recordings/_costs/<ACTION_LOG_ID>.json` unchanged. Call sites in
 * captcha/solver.ts, utils/sms.ts, and session/wsession.ts are unmodified.
 *
 * If COST_SUPABASE_URL + COST_SUPABASE_KEY are set, records are also written
 * to the central cost_records table at flush time. When unset, only the
 * local file is written.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CostTracker as SharedCostTracker,
  PRICES as SHARED_PRICES,
  SupabaseSink,
} from '@wisent/cost-tracker';

// Re-export the canonical PRICES table for any in-repo code that read it.
export const PRICES = SHARED_PRICES;

function round4(n: number): number { return Math.round(n * 10000) / 10000; }

class WelesCostTracker {
  private inner: SharedCostTracker;
  private agent_id: string;

  constructor() {
    const supabaseUrl = process.env.COST_SUPABASE_URL ?? process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.COST_SUPABASE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
    const agent_id = process.env.ACTION_LOG_ID ?? `weles-${process.pid}`;
    this.agent_id = agent_id;
    // We use 'memory' sink internally and add Supabase persistence ourselves
    // in flush(); this lets us write the legacy recordings/_costs file and
    // the central table in one shot.
    this.inner = new SharedCostTracker({
      agent_id,
      reference_id: process.env.ACTION_LOG_ID,
      sink: 'memory',
      autoFlush: false,
    });
    // Save Supabase config for flush(). Don't fail if creds are missing —
    // CI / dev environments without Supabase still get the local file.
    if (supabaseUrl && supabaseKey) {
      this._supabase = new SupabaseSink({ url: supabaseUrl, key: supabaseKey });
    }
    // Auto-flush on process exit.
    process.on('beforeExit', () => { void this.flush(); });
    process.on('SIGINT', () => { void this.flush().finally(() => process.exit(130)); });
    process.on('SIGTERM', () => { void this.flush().finally(() => process.exit(143)); });
  }

  private _supabase: SupabaseSink | null = null;

  // Legacy weles API surface — call sites in solver.ts, sms.ts, wsession.ts
  // expect these exact method shapes.
  record(service: string, usd: number): void {
    if (!service || !Number.isFinite(usd) || usd <= 0) return;
    this.inner.record({ service, usage_type: 'units', usage_amount: 1, cost_usd: usd });
  }

  recordCaptcha(service: keyof typeof SHARED_PRICES.captcha, taskType: string, override?: number): void {
    this.inner.recordCaptcha(String(service), taskType, override);
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

    if (this._supabase) {
      try {
        const stamped = snap.records.map(r => ({ ...r, agent_id: this.agent_id })) as any;
        await this._supabase.write(stamped);
      } catch (e: any) {
        console.log(`[cost] Supabase flush err: ${e.message?.slice(0, 120)}`);
      }
    }
  }
}

export const costTracker = new WelesCostTracker();
