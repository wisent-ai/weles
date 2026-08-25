/**
 * Per-trajectory cost tracker.
 *
 * Thin wrapper around @wisent/cost-tracker. Each Stado job writes its cost
 * rollup under recordings/_costs/<ACTION_LOG_ID>.json for artifact capture.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CostTracker as SharedCostTracker,
  PRICES as SHARED_PRICES,
} from '@wisent/cost-tracker';
import { recordCaptchaSolved } from '../captcha/events.js';

// Re-export the canonical PRICES table for any in-repo code that read it.
export const PRICES = SHARED_PRICES;

function round4(n: number): number { return Math.round(n * 10000) / 10000; }

class WelesCostTracker {
  private inner: SharedCostTracker;

  constructor() {
    const agent_id = process.env.ACTION_LOG_ID ?? `weles-${process.pid}`;
    this.inner = new SharedCostTracker({
      agent_id,
      reference_id: process.env.ACTION_LOG_ID,
      sink: 'memory',
      autoFlush: false,
    });
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

  /** Drain current records into the Stado job's local cost artifact. */
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

  }


  /** Synchronous local-file flush for trajectories that call process.exit(). */
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
