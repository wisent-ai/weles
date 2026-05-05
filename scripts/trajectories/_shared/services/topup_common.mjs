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

// Stripe Elements card-form filler. Cited 2026-05-04: pingproxies/iproyal/
// oxylabs all bottom out at "no saved card available" — the topup modal
// has Stripe Elements iframes that need card details filled. Each
// Elements input lives in its own cross-origin iframe at js.stripe.com,
// frame URL contains the field type (card-number / card-expiry /
// card-cvc / postal-code).
const STRIPE_FRAME_PATTERNS = {
  cardNumber: /elements-inner-(card-?number|cardNumber)/i,
  cardExpiry: /elements-inner-(card-?expiry|cardExpiry)/i,
  cardCvc: /elements-inner-(card-?cvc|cardCvc)/i,
  postalCode: /elements-inner-(postal-?code|postalCode)/i,
};

function getCardEnv() {
  const num = process.env.TOPUP_CARD_NUMBER ?? '';
  const exp = process.env.TOPUP_CARD_EXP ?? '';
  const cvc = process.env.TOPUP_CARD_CVC ?? '';
  const zip = process.env.TOPUP_CARD_ZIP ?? '';
  if (!num || !exp || !cvc) return null;
  return { num, exp, cvc, zip };
}

async function findStripeFrame(page, pat) {
  for (const f of page.frames()) {
    if (pat.test(f.url())) return f;
  }
  return null;
}

export async function fillStripeElements(page, card = null) {
  const c = card ?? getCardEnv();
  if (!c) return { ok: false, reason: 'no_card_env' };
  for (let i = 0; i < 20; i++) {
    if (await findStripeFrame(page, STRIPE_FRAME_PATTERNS.cardNumber)) break;
    await page.waitForTimeout(500);
  }
  const filled = {};
  for (const [field, pat] of Object.entries(STRIPE_FRAME_PATTERNS)) {
    const value = field === 'cardNumber' ? c.num : field === 'cardExpiry' ? c.exp : field === 'cardCvc' ? c.cvc : c.zip;
    if (!value) continue;
    const f = await findStripeFrame(page, pat);
    if (!f) { filled[field] = 'frame_not_found'; continue; }
    const input = f.locator('input').first();
    if (!(await input.isVisible().catch(() => false))) { filled[field] = 'input_not_visible'; continue; }
    await input.click({ force: true }).catch(() => {});
    await page.keyboard.type(value, { delay: 50 });
    filled[field] = 'filled';
  }
  const ok = filled.cardNumber === 'filled' && filled.cardExpiry === 'filled' && filled.cardCvc === 'filled';
  return { ok, filled };
}
