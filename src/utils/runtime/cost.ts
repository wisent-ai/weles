/**
 * Per-trajectory cost tracker.
 *
 * Thin wrapper around @wisent/cost-tracker. Each Stado job writes its cost
 * rollup under recordings/_costs/<ACTION_LOG_ID>.json for artifact capture;
 * a run without ACTION_LOG_ID keeps its costs in memory and says so on exit.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CostTracker as SharedCostTracker,
  type CostRecord,
} from '@wisent/cost-tracker';
import { recordCaptchaSolved } from '../../captcha/events.js';

interface CostRollup {
  cost_usd: number;
  service_costs: Record<string, number>;
}

/** The rollup already in `path`, or an empty one when the run has written none; an unreadable file is an error, never overwritten. */
function storedRollup(path: string): CostRollup {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return { cost_usd: Number(), service_costs: {} };
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('cost_usd' in parsed) ||
    !('service_costs' in parsed)
  ) {
    throw new Error(
      `${path} is not a cost rollup (cost_usd and service_costs)`,
    );
  }
  return parsed as CostRollup;
}

/** `records` added onto `rollup`. */
function addedTo(rollup: CostRollup, records: CostRecord[]): CostRollup {
  const service_costs = { ...rollup.service_costs };
  let cost_usd = rollup.cost_usd;
  for (const record of records) {
    service_costs[record.service] =
      (Object.hasOwn(service_costs, record.service)
        ? service_costs[record.service]
        : Number()) + record.cost_usd;
    cost_usd += record.cost_usd;
  }
  return { cost_usd, service_costs };
}

class WelesCostTracker {
  private readonly inner: SharedCostTracker;
  private readonly runId: string | undefined;
  /** How many of the tracker's records are already in the rollup file. */
  private written = Number();

  constructor() {
    this.runId = process.env.ACTION_LOG_ID;
    this.inner = new SharedCostTracker({
      agent_id: this.runId ? this.runId : `weles-process-${process.pid}`,
      reference_id: this.runId,
      sink: 'memory',
      autoFlush: false,
    });
    // 'exit' fires on a natural drain and on process.exit(); only synchronous
    // work runs there, so the rollup is written synchronously.
    process.on('exit', () => this.flushOrReport());
    // A signal ends the process without 'exit': write the rollup, then
    // re-raise the signal so the process ends with the status it would have.
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        this.flushOrReport();
        process.kill(process.pid, signal);
      });
    }
  }

  recordCaptcha(service: string, taskType: string, override?: number): void {
    const record = this.inner.recordCaptcha(service, taskType, override);
    // Every successful solve also enters the run's captcha event log, with
    // the cost the pricing table gave it.
    recordCaptchaSolved(service, taskType, record.cost_usd);
  }

  recordSms(provider: string, service: string, override?: number): void {
    this.inner.recordSms(provider, service, override);
  }

  recordProxyBytes(provider: string, bytes: number, isMobile: boolean): void {
    this.inner.recordProxyBytes(provider, bytes, isMobile);
  }

  /** Adds the records not yet written to the Stado job's local cost rollup. */
  flushLocalSync(): void {
    const { records } = this.inner.snapshot();
    const fresh = records.slice(this.written);
    if (!fresh.length) return;
    if (!this.runId) {
      throw new Error(
        `ACTION_LOG_ID is not set, so ${fresh.length} cost records of this run have no rollup file to go to`,
      );
    }
    const path = join(
      process.cwd(),
      'recordings',
      '_costs',
      `${this.runId}.json`,
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(addedTo(storedRollup(path), fresh)));
    this.written = records.length;
  }

  /** flushLocalSync where nothing can be thrown to: the cause goes to stderr, the only output left at exit. */
  private flushOrReport(): void {
    try {
      this.flushLocalSync();
    } catch (flushError) {
      process.stderr.write(
        `[cost] cost rollup not written: ${flushError instanceof Error ? flushError.message : String(flushError)}\n`,
      );
    }
  }
}

export const costTracker = new WelesCostTracker();
