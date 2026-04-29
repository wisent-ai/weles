/**
 * Per-trajectory cost tracker. Trajectories accumulate per-service costs as
 * they call captcha/sms/proxy modules; on process exit the tracker writes a
 * cost.json file in recordings/<action>/ that the worker reads and PATCHes
 * into account_action_logs.{cost_usd,service_costs}.
 *
 * Pricing source: each provider's public pricing page snapshots taken
 * 2026-04-29 plus values returned by the JuicySMS API at order time.
 * Prices are upper-bound estimates rounded to 4 decimals — a $0 in the DB
 * means no consumer has been wired yet, not that the action was free.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Per-task USD prices. Keys match the service name written into service_costs.
export const PRICES = {
  capsolver: {
    recaptcha_v2: 0.0008, recaptcha_v3: 0.001, hcaptcha: 0.0008,
    funcaptcha: 0.0015, turnstile: 0.0012, default: 0.001,
  },
  anticaptcha: {
    recaptcha_v2: 0.001, recaptcha_v3: 0.001, hcaptcha: 0.001,
    funcaptcha: 0.002, default: 0.001,
  },
  capmonster: {
    recaptcha_v2: 0.0006, recaptcha_v3: 0.0006, hcaptcha: 0.0006,
    funcaptcha: 0.0012, default: 0.0006,
  },
  twocaptcha: {
    recaptcha_v2: 0.001, recaptcha_v3: 0.001, hcaptcha: 0.001,
    funcaptcha: 0.0028, default: 0.001,
  },
  nocaptcha: { perimeterx: 0.005, default: 0.005 },
  // SMS prices vary heavily by service. Caller passes the platform key when
  // recording. JuicySMS API returns the actual price in the order response;
  // prefer that value over the table when present.
  juicysms: {
    reddit: 0.20, twitter: 0.30, instagram: 0.50,
    discord: 0.15, tiktok: 0.30, google: 0.30,
    telegram: 0.15, whatsapp: 0.50, facebook: 0.30,
    yahoo: 0.15, linkedin: 0.30, default: 0.30,
  },
  smsactivate: {
    reddit: 0.15, twitter: 0.20, instagram: 0.30,
    discord: 0.10, tiktok: 0.20, google: 0.20, default: 0.20,
  },
  // Per-GB residential proxy egress pricing (USD / GB). Datacenter / mobile
  // override per provider — Oxylabs Mobile is $9/GB, Brightdata zone-dependent.
  proxy_gb: {
    brightdata: 8.40, oxylabs: 7.50, oxylabs_mobile: 9.00,
    packetstream: 1.00, pingproxies: 1.50, iproyal: 7.00,
    default: 5.00,
  },
} as const;

class CostTracker {
  private costs: Record<string, number> = {};
  private flushed = false;

  record(service: string, usd: number): void {
    if (!service || !Number.isFinite(usd) || usd <= 0) return;
    this.costs[service] = (this.costs[service] ?? 0) + usd;
  }

  recordCaptcha(service: keyof typeof PRICES, taskType: string, override?: number): void {
    const table = (PRICES as any)[service] as Record<string, number> | undefined;
    const price = override ?? table?.[taskType] ?? table?.default ?? 0.001;
    this.record(service, price);
  }

  recordSms(provider: 'juicysms' | 'smsactivate', service: string, override?: number): void {
    const table = PRICES[provider] as Record<string, number>;
    const price = override ?? table[service.toLowerCase()] ?? table.default;
    this.record(provider, price);
  }

  /**
   * Record proxy egress. bytes is total bytes consumed via the upstream
   * provider. provider matches the row key ('brightdata', 'oxylabs',
   * 'packetstream', 'pingproxies', 'iproyal'). Cost is rounded to 4dp.
   */
  recordProxyBytes(provider: string, bytes: number, isMobile = false): void {
    if (!provider || bytes <= 0) return;
    const key = isMobile && provider === 'oxylabs' ? 'oxylabs_mobile' : provider;
    const perGb = (PRICES.proxy_gb as Record<string, number>)[key] ?? PRICES.proxy_gb.default;
    const gb = bytes / (1024 * 1024 * 1024);
    const cost = Math.round(gb * perGb * 10000) / 10000;
    if (cost > 0) this.record(`proxy_${provider}${isMobile ? '_mobile' : ''}`, cost);
  }

  total(): number {
    return Math.round(Object.values(this.costs).reduce((a, b) => a + b, 0) * 10000) / 10000;
  }

  snapshot(): { cost_usd: number; service_costs: Record<string, number> } {
    const service_costs: Record<string, number> = {};
    for (const [k, v] of Object.entries(this.costs)) service_costs[k] = Math.round(v * 10000) / 10000;
    return { cost_usd: this.total(), service_costs };
  }

  async flush(): Promise<void> {
    if (this.flushed) return;
    this.flushed = true;
    // Worker sets ACTION_LOG_ID + the trajectory file path is implied by
    // recordings/<action>/. We don't have action name reliably from env, so
    // write to a stable location keyed by ACTION_LOG_ID — worker matches by id.
    const id = process.env.ACTION_LOG_ID;
    if (!id) return;
    if (Object.keys(this.costs).length === 0) return;
    const path = join(process.cwd(), 'recordings', '_costs', `${id}.json`);
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(this.snapshot()));
    } catch { /* noop — best-effort */ }
  }
}

export const costTracker = new CostTracker();

// Auto-flush on process exit. beforeExit fires for normal exits (event loop
// drained); exit fires synchronously and can't await, so we use beforeExit.
let exitHooked = false;
function ensureExitHook(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on('beforeExit', () => { void costTracker.flush(); });
  // SIGINT / SIGTERM — write best-effort sync version. We write through the
  // async path; if the process is being killed we'll lose data, acceptable.
  process.on('SIGINT', () => { void costTracker.flush().finally(() => process.exit(130)); });
  process.on('SIGTERM', () => { void costTracker.flush().finally(() => process.exit(143)); });
}
ensureExitHook();
