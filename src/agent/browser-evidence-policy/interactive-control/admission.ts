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

// What a page control has to look like before an evidence run refuses it,
// declared in `withheld-categories.json` beside this file: one family per
// category, in the order they are tested, each with the reason the run
// keeps its hands off and the reason it sits where it sits.
import declaredWithholding from './withheld-categories.json';

const WITHHELD_CATEGORIES = declaredWithholding.categories.map((declared) => ({
  name: declared.name,
  reason: declared.reason,
  test: new RegExp(declared.pattern, 'i'),
}));

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
  const flags: Record<string, boolean> = {
    download: Boolean(control?.download),
    formHasOneTimeCode: Boolean(control?.formHasOneTimeCode),
    formHasPassword: Boolean(control?.formHasPassword),
    formHasMessage: Boolean(control?.formHasMessage),
  };
  const flagged = new Set(
    Object.entries(declaredWithholding.flag_categories)
      .filter(([flag]) => flags[flag])
      .map(([, category]) => category),
  );
  for (const category of WITHHELD_CATEGORIES) {
    if (category.test.test(combined) || flagged.has(category.name)) {
      return { category: category.name, reason: category.reason };
    }
  }
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
