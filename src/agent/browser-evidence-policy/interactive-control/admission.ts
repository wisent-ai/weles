// Which requests this policy admits at all: the tools that are never available
// to a browser-evidence run, the page keys that always are, the withheld
// category a request's text falls into, and whether one resolved control is a
// plain same-origin link, disclosure or read-only search input. Everything here
// is a judgement over already-read facts, so it needs no page and no evidence
// directory; the caller records the decision it returns.
import type { ControlDescriptor } from './descriptors.js';
import { safeText } from '../withheld-ledger.js';

export const SAFE_PAGE_KEYS: Record<string, true> = {
  ArrowDown: true,
  ArrowLeft: true,
  ArrowRight: true,
  ArrowUp: true,
  End: true,
  Escape: true,
  Home: true,
  PageDown: true,
  PageUp: true,
  'Shift+Tab': true,
  Tab: true,
};

export const ALWAYS_WITHHELD_TOOLS: Record<string, { category: string; reason: string }> = {
  fill_credential: { category: 'authentication_submission', reason: 'credential use is unavailable to browser-evidence tasks' },
  fill_identity: { category: 'authentication_submission', reason: 'identity use is unavailable to browser-evidence tasks' },
  store_credential: { category: 'authentication_submission', reason: 'credential storage is unavailable to browser-evidence tasks' },
  solve_captcha: { category: 'authentication_submission', reason: 'challenge submission is unavailable to browser-evidence tasks' },
  check_email: { category: 'account_recovery_submission', reason: 'email verification is unavailable to browser-evidence tasks' },
  generate_identity: { category: 'authentication_submission', reason: 'account creation is unavailable to browser-evidence tasks' },
  check_sms: { category: 'mfa_2fa', reason: 'SMS verification is unavailable to browser-evidence tasks' },
  poll_sms_code: { category: 'mfa_2fa', reason: 'SMS verification is unavailable to browser-evidence tasks' },
  save_account: { category: 'authentication_submission', reason: 'account creation is unavailable to browser-evidence tasks' },
  set_control: { category: 'unresolved_interactive_control', reason: 'generic control mutation is unavailable to browser-evidence tasks' },
};

const PERMISSION_RE = /\b(allow|enable|grant|turn on|permission|camera|microphone|location|geolocation|clipboard)\b/i;
const NOTIFICATION_RE = /\b(notification|notify me|push alert|browser alert)\b/i;
const DOWNLOAD_RE = /\b(download|export|save (?:as|file)|open (?:in|with)|launch (?:app|application))\b/i;
const AUTH_RE = /\b(sign[ -]?in|log[ -]?in|sign[ -]?up|create (?:an )?account|register|continue with (?:google|apple|facebook|microsoft)|authenticate)\b/i;
const RECOVERY_RE = /\b(forgot|reset|recover|recovery|restore access|unlock account)\b/i;
const MFA_RE = /\b(mfa|2fa|two[ -]?factor|multi[ -]?factor|one[ -]?time|verification code|security code|authenticator|passkey|otp)\b/i;
const TRUSTED_DEVICE_RE = /\b(trust(?:ed)? (?:this )?device|remember (?:this )?device|don['’]?t ask again|keep me signed in)\b/i;
const MESSAGE_RE = /\b(send|submit message|post|publish|comment|reply|contact|invite|share)\b/i;
const COMMERCE_RE = /\b(buy|purchase|subscribe|checkout|pay|payment|place order|confirm order|upgrade plan|start trial)\b/i;
const DESTRUCTIVE_RE = /\b(delete|destroy|erase|remove permanently|revoke|deactivate|terminate|close account|cancel account|confirm deletion)\b/i;

export function targetText(tool: string, args: Record<string, unknown>): string {
  const parts = [args.target, args.selector, args.text, tool === 'press_key' ? args.key : undefined];
  return parts.map(safeText).filter(Boolean).join(' ');
}

function normalizedControlText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function matchingControl(target: string, descriptors: ControlDescriptor[]): ControlDescriptor | null {
  const normalized = normalizedControlText(target);
  if (!normalized) return null;
  const matches = descriptors.filter((control) => normalizedControlText(control.label) === normalized);
  return matches.length === 1 ? matches[0] : null;
}

export function classify(text: string, control: ControlDescriptor | null, pageUrl: string): { category: string; reason: string } | null {
  const combined = `${text} ${control?.label ?? ''} ${control?.href ?? ''} ${control?.formText ?? ''} ${control?.formAction ?? ''} ${pageUrl}`;
  if (NOTIFICATION_RE.test(combined)) return { category: 'notification_control', reason: 'notification permission/control withheld' };
  if (PERMISSION_RE.test(combined)) return { category: 'browser_permission_control', reason: 'browser permission control withheld' };
  if (DOWNLOAD_RE.test(combined) || control?.download) return { category: 'system_ui_download', reason: 'download or external application control withheld' };
  if (MFA_RE.test(combined) || control?.formHasOneTimeCode) return { category: 'mfa_2fa', reason: 'MFA/2FA control withheld' };
  if (TRUSTED_DEVICE_RE.test(combined)) return { category: 'trusted_device', reason: 'trusted-device control withheld' };
  if (RECOVERY_RE.test(combined)) return { category: 'account_recovery_submission', reason: 'account recovery submission withheld' };
  if (AUTH_RE.test(combined) || control?.formHasPassword) return { category: 'authentication_submission', reason: 'sign-in/sign-up submission withheld' };
  if (COMMERCE_RE.test(combined)) return { category: 'purchase_subscription_payment', reason: 'purchase/subscription/payment control withheld' };
  if (DESTRUCTIVE_RE.test(combined)) return { category: 'destructive_confirmation', reason: 'final destructive confirmation withheld' };
  if (MESSAGE_RE.test(combined) || control?.formHasMessage) return { category: 'messaging_submission', reason: 'message-capable form submission withheld' };
  return null;
}

export function readOnlyForm(control: ControlDescriptor, pageUrl: string): boolean {
  if (!control.formPresent) return true;
  if (control.formMethod !== 'get') return false;
  try {
    return new URL(control.formAction || pageUrl, pageUrl).origin === new URL(pageUrl).origin;
  } catch {
    return false;
  }
}

export function safeClick(control: ControlDescriptor, pageUrl: string): boolean {
  if (control.tag === 'a' || control.role === 'link') {
    try {
      const destination = new URL(control.href);
      return destination.protocol === 'https:'
        && destination.origin === new URL(pageUrl).origin
        && !control.download
        && (!control.target || control.target === '_self');
    } catch {
      return false;
    }
  }
  if (control.role === 'tab' && !control.formPresent) return true;
  if (control.tag === 'summary' && !control.formPresent) return true;
  // A disclosure control is a button that only opens or closes something it
  // names: it must carry aria-controls and an aria-expanded that is already
  // either true or false, so an absent attribute is not a disclosure.
  const disclosure = !control.formPresent
    && (control.tag === 'button' || control.role === 'button')
    && Boolean(control.ariaControls)
    && (control.ariaExpanded === 'true' || control.ariaExpanded === 'false')
    && (control.type === 'button' || control.type === '');
  return disclosure;
}
