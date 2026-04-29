// Shared scaffolding for service-credential topup trajectories.
// Dry-run by default: fill amount + screenshot + exit. TOPUP_CONFIRM=1 to charge.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function topupOpts() {
  const usd = Number(process.env.TOPUP_USD ?? '10');
  const confirm = process.env.TOPUP_CONFIRM === '1';
  if (!Number.isFinite(usd) || usd <= 0) {
    console.log(`FAIL: invalid TOPUP_USD=${process.env.TOPUP_USD}`);
    process.exit(1);
  }
  return { usd, confirm };
}

export async function dryRunExit(session, label, usd) {
  try {
    const dir = join(process.cwd(), 'recordings', `${label}_topup`);
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(dir, `dry-run-${ts}.png`);
    await session.page.screenshot({ path, fullPage: true }).catch(() => {});
    console.log(`PASS-DRY: would charge $${usd}; screenshot=${path}`);
    console.log('Set TOPUP_CONFIRM=1 + TOPUP_USD=<amount> to actually submit payment.');
  } catch (e) { console.log('[dry-run] screenshot err:', e.message); }
}
