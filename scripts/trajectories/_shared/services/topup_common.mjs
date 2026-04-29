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

// Generic pay button finder - tries common selectors for checkout buttons.
export async function findAndClickPayButton(page) {
  const selectors = [
    'button:has-text("Pay")',
    'button:has-text("Checkout")',
    'button:has-text("Purchase")',
    'button:has-text("Buy")',
    'button:has-text("Add Funds")',
    'button:has-text("Proceed")',
    'button:has-text("Submit")',
    'button:has-text("Confirm")',
    'button:has-text("Top up")',
    'button:has-text("Recharge")',
    'a:has-text("Pay")',
    'a:has-text("Checkout")',
    'input[type="submit"][value*="Pay" i]',
    'input[type="submit"][value*="Buy" i]',
  ];
  for (const sel of selectors) {
    const btn = page.locator(sel).filter({ visible: true }).first();
    if (await btn.isVisible().catch(() => false)) {
      console.log(`[topup] clicking pay button: ${sel}`);
      await btn.click();
      return true;
    }
  }
  return false;
}
