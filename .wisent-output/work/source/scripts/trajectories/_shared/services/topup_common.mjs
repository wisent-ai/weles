// Shared scaffolding for service-credential topup trajectories.
// TOPUP_CONFIRM=1 is required before any provider topup flow can continue.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { humanIdlePause } from '../../../../dist/human/mouse.js';
import { humanType } from '../../../../dist/human/keyboard.js';

export function topupOpts() {
  const usd = Number(process.env.TOPUP_USD ?? '10');
  if (!Number.isFinite(usd) || usd <= 0) {
    console.log(`FAIL: invalid TOPUP_USD=${process.env.TOPUP_USD}`);
    process.exit(1);
  }
  if (process.env.TOPUP_CONFIRM !== '1') {
    console.log('FAIL: TOPUP_CONFIRM=1 required before charging');
    process.exit(2);
  }
  return { usd };
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
  cardNumber: /elements-inner-(card-?number|cardNumber|payment-card-?number|payment[^/]*card-?number)/i,
  cardExpiry: /elements-inner-(card-?expiry|cardExpiry|payment-card-?expiry|payment[^/]*card-?expiry)/i,
  cardCvc: /elements-inner-(card-?cvc|cardCvc|payment-card-?cvc|payment[^/]*card-?cvc)/i,
  postalCode: /elements-inner-(postal-?code|postalCode|payment-postal-?code|payment[^/]*postal-?code)/i,
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

// Autocomplete-driven fill works across both layouts:
// (a) split layout — separate iframe per field, URL like elements-inner-card-number
// (b) unified layout — all inputs in one frame (elements-inner-accessory-target,
//     iproyal/clover variant). Inputs are named by autocomplete attribute:
//     cc-number / cc-exp / cc-csc / billing postal-code.
const AUTOCOMPLETE_FIELD_MAP = {
  cardNumber: 'cc-number',
  cardExpiry: 'cc-exp',
  cardCvc: 'cc-csc',
  postalCode: 'billing postal-code',
};

async function findInputByAutocomplete(page, autocomplete) {
  for (const f of page.frames()) {
    if (!/stripe\.com|m\.stripe\.network/.test(f.url())) continue;
    try {
      const handle = await f.$(`input[autocomplete="${autocomplete}"]`);
      if (handle) {
        const visible = await handle.isVisible().catch(() => false);
        if (visible) return { frame: f, handle };
      }
    } catch {}
  }
  return null;
}

export async function fillStripeElements(page, card = null) {
  const c = card ?? getCardEnv();
  if (!c) return { ok: false, reason: 'no_card_env' };
  // Wait up to 15s for the card number input to become reachable in any Stripe frame.
  let cardEntry = null;
  for (let i = 0; i < 30; i++) {
    cardEntry = await findInputByAutocomplete(page, 'cc-number');
    if (cardEntry) break;
    await humanIdlePause('short');
  }
  if (!cardEntry) return { ok: false, reason: 'cc-number_input_not_found' };
  const filled = {};
  for (const [field, autocomplete] of Object.entries(AUTOCOMPLETE_FIELD_MAP)) {
    const value = field === 'cardNumber' ? c.num : field === 'cardExpiry' ? c.exp : field === 'cardCvc' ? c.cvc : c.zip;
    if (!value) { filled[field] = 'no_value'; continue; }
    const entry = field === 'cardNumber' ? cardEntry : await findInputByAutocomplete(page, autocomplete);
    if (!entry) { filled[field] = 'input_not_found'; continue; }
    try {
      await entry.handle.click({ force: true });
      await entry.handle.fill('').catch(() => {});
      await humanType(page, value, { delay: 50 });
      filled[field] = 'filled';
    } catch (e) {
      filled[field] = `err:${e.message?.slice(0, 40)}`;
    }
  }
  const ok = filled.cardNumber === 'filled' && filled.cardExpiry === 'filled' && filled.cardCvc === 'filled';
  return { ok, filled };
}

// Orchestrator: source ~/.weles/topup_card.env, validate vars, spawn provider trajectory.
const TOPUP_ENV_FILE = join(homedir(), '.weles', 'topup_card.env');
const TOPUP_REQUIRED = ['TOPUP_CARD_NUMBER', 'TOPUP_CARD_EXP', 'TOPUP_CARD_CVC'];
const TOPUP_PROVIDERS = ['iproyal', 'oxylabs', 'pingproxies', 'brightdata'];

function loadCardEnvFile() {
  if (!existsSync(TOPUP_ENV_FILE)) {
    console.log(`BLOCKER: ${TOPUP_ENV_FILE} does not exist. Copy ${TOPUP_ENV_FILE}.template, paste card values from Rho dashboard, chmod 600.`);
    return false;
  }
  const text = readFileSync(TOPUP_ENV_FILE, 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (k && v && !process.env[k]) process.env[k] = v;
  }
  return true;
}

export async function runTopupOrchestrator(provider, usd, currentFileUrl) {
  if (!TOPUP_PROVIDERS.includes(provider)) {
    console.log(`BLOCKER: unknown provider ${provider}. Allowed: ${TOPUP_PROVIDERS.join(', ')}`);
    process.exit(1);
  }
  const usdNum = Number(usd ?? '30');
  if (!Number.isFinite(usdNum) || usdNum <= 0) {
    console.log(`BLOCKER: invalid usd=${usd}`);
    process.exit(1);
  }
  if (!loadCardEnvFile()) process.exit(1);
  // Also source weles/.env so the trajectory's SUPABASE_* lookups work when invoked via node directly.
  const welesEnv = join(dirname(fileURLToPath(currentFileUrl)), '..', '..', '..', '..', '.env');
  if (existsSync(welesEnv)) {
    for (const raw of readFileSync(welesEnv, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (k && v && !process.env[k]) process.env[k] = v;
    }
  }
  const missing = TOPUP_REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.log(`BLOCKER: missing card env vars in ${TOPUP_ENV_FILE}: ${missing.join(', ')}`);
    process.exit(1);
  }
  const here = dirname(fileURLToPath(currentFileUrl));
  const trajectory = join(here, '..', '..', provider, 'topup.mjs');
  if (!existsSync(trajectory)) {
    console.log(`BLOCKER: trajectory not found: ${trajectory}`);
    process.exit(1);
  }
  console.log(`[orchestrator] provider=${provider} usd=$${usdNum} card=****${process.env.TOPUP_CARD_NUMBER.slice(-4)}`);
  const child = spawn('node', [trajectory], {
    env: { ...process.env, TOPUP_USD: String(usdNum), TOPUP_CONFIRM: '1' },
    stdio: 'inherit',
  });
  return new Promise((resolve) => {
    child.on('exit', (code) => {
      console.log(`[orchestrator] ${provider} topup exited with code ${code}`);
      resolve(code ?? 1);
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , provider, usd] = process.argv;
  if (!provider) {
    console.log(`Usage: node ${process.argv[1]} <${TOPUP_PROVIDERS.join('|')}> <usd>`);
    process.exit(1);
  }
  const code = await runTopupOrchestrator(provider, usd ?? '30', import.meta.url);
  process.exit(code);
}
