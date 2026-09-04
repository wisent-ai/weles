import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, ElementHandle, Page } from 'playwright';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { WSession } from '../session/wsession.js';
import { runRecordingsDir } from '../session/run-recordings.js';

export const SPIS_BROWSER_EVIDENCE_POLICY = Object.freeze({
  schema: 'weles.browser-evidence-policy.v1',
  version: 'spis-browser-evidence.1',
  constraints: Object.freeze([
    'browser-permission-apis:withhold',
    'notification-apis:withhold',
    'permission-notification-controls:withhold',
    'system-ui-downloads:withhold',
    'authentication-signup-recovery:withhold',
    'mfa-trusted-device:withhold',
    'message-submission:withhold',
    'commerce-payment:withhold',
    'destructive-confirmation:withhold',
    'network:exact-public-origin-pinned',
    'interactive-controls:default-deny',
  ] as const),
});

const POLICY_FILE = 'browser_evidence_policy.json';
const WITHHELD_FILE = 'browser_evidence_withheld_edges.ndjson';
const MAX_EDGE_TEXT = 240;
const MAX_WITHHELD_BYTES = 2 * 1024 * 1024;
const MAX_WITHHELD_EDGES = 2_048;
const MAX_EDGE_LINE_BYTES = 4_096;
const edgeStates = new Map<string, { bytes: number; count: number; truncated: boolean }>();
const SAFE_PAGE_KEYS: Record<string, true> = {
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
const DENIED_HOSTNAMES: Record<string, true> = {
  localhost: true,
  metadata: true,
  'metadata.google.internal': true,
  'instance-data': true,
  'instance-data.ec2.internal': true,
};
const NETWORK_BLOCK_LIST = new BlockList();
for (const [address, prefix, family] of [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['192.88.99.0', 24, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['::ffff:0:0', 96, 'ipv6'],
  ['64:ff9b::', 96, 'ipv6'],
  ['64:ff9b:1::', 48, 'ipv6'],
  ['100::', 64, 'ipv6'],
  ['2001::', 23, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
  ['2002::', 16, 'ipv6'],
  ['3ffe::', 16, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fec0::', 10, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
] as const) {
  NETWORK_BLOCK_LIST.addSubnet(address, prefix, family);
}

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

function enabled(): boolean {
  return process.env.WELES_BROWSER_EVIDENCE_POLICY === SPIS_BROWSER_EVIDENCE_POLICY.version;
}

function safeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_EDGE_TEXT);
}

function evidenceDirectory(label: string): string {
  const directory = runRecordingsDir(label || 'generic_browser_task');
  mkdirSync(directory, { recursive: true });
  return directory;
}

function recordEdge(label: string, edge: Record<string, unknown>): void {
  const path = join(evidenceDirectory(label), WITHHELD_FILE);
  const state = edgeStates.get(path) ?? { bytes: 0, count: 0, truncated: false };
  const document = {
    schema: 'weles.browser-evidence-withheld-edge.v1',
    policyVersion: SPIS_BROWSER_EVIDENCE_POLICY.version,
    recordedAt: new Date().toISOString(),
    ...edge,
  };
  let line = `${JSON.stringify(document)}\n`;
  if (Buffer.byteLength(line) > MAX_EDGE_LINE_BYTES) {
    line = `${JSON.stringify({
      schema: 'weles.browser-evidence-withheld-edge.v1',
      policyVersion: SPIS_BROWSER_EVIDENCE_POLICY.version,
      recordedAt: document.recordedAt,
      category: safeText(edge.category) || 'withheld_edge',
      reason: 'withheld edge detail exceeded the per-entry bound',
      source: safeText(edge.source) || 'policy',
    })}\n`;
  }
  const lineBytes = Buffer.byteLength(line);
  if (state.count >= MAX_WITHHELD_EDGES || state.bytes + lineBytes > MAX_WITHHELD_BYTES - 512) {
    if (!state.truncated) {
      const marker = `${JSON.stringify({
        schema: 'weles.browser-evidence-withheld-edge.v1',
        policyVersion: SPIS_BROWSER_EVIDENCE_POLICY.version,
        recordedAt: new Date().toISOString(),
        category: 'retention_limit',
        reason: 'additional withheld edges omitted after the execution-time retention bound',
        source: 'policy',
      })}\n`;
      appendFileSync(path, marker, { encoding: 'utf8', mode: 0o600 });
      state.bytes += Buffer.byteLength(marker);
      state.truncated = true;
    }
    edgeStates.set(path, state);
    return;
  }
  appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 });
  state.bytes += lineBytes;
  state.count += 1;
  edgeStates.set(path, state);
}

export function writeBrowserEvidencePolicy(label: string): void {
  if (!enabled()) return;
  writeFileSync(
    join(evidenceDirectory(label), POLICY_FILE),
    `${JSON.stringify(SPIS_BROWSER_EVIDENCE_POLICY, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

function initScript(policyVersion: string): void {
  const report = (category: string, api: string) => {
    try {
      const reportingGlobal = globalThis as unknown as {
        __welesRecordWithheldEdge?: (edge: unknown) => unknown;
      };
      void reportingGlobal.__welesRecordWithheldEdge?.({ category, api, source: 'page_api' });
    } catch {}
  };
  const denied = () => new DOMException('Withheld by Weles browser-evidence policy', 'NotAllowedError');
  const denyAsyncMethods = (owner: unknown, methods: string[], category: string, prefix: string) => {
    if (!owner || (typeof owner !== 'object' && typeof owner !== 'function')) return;
    for (const method of methods) {
      try {
        const record = owner as Record<string, unknown>;
        if (typeof record[method] !== 'function') continue;
        Object.defineProperty(owner, method, {
          configurable: false,
          value: async () => {
            report(category, `${prefix}.${method}`);
            throw denied();
          },
        });
      } catch {}
    }
  };

  try {
    if (navigator.permissions) {
      Object.defineProperty(navigator.permissions, 'query', {
        configurable: false,
        value: (descriptor: PermissionDescriptor) => {
          const name = String(descriptor?.name ?? 'unknown');
          report(name === 'notifications' ? 'notification_api' : 'browser_permission_api', `permissions.query:${name}`);
          return Promise.resolve({ state: 'denied', onchange: null } as PermissionStatus);
        },
      });
    }
  } catch {}

  try {
    Object.defineProperty(globalThis, 'Notification', {
      configurable: false,
      value: class WithheldNotification {
        static get permission(): NotificationPermission { return 'denied'; }
        static async requestPermission(): Promise<NotificationPermission> {
          report('notification_api', 'Notification.requestPermission');
          return 'denied';
        }
        constructor() {
          report('notification_api', 'new Notification');
          throw denied();
        }
      },
    });
  } catch {}

  try {
    const media = navigator.mediaDevices;
    denyAsyncMethods(media, ['getUserMedia', 'getDisplayMedia', 'selectAudioOutput'], 'browser_permission_api', 'mediaDevices');
  } catch {}

  try {
    const geo = navigator.geolocation;
    if (geo) {
      Object.defineProperty(geo, 'getCurrentPosition', {
        configurable: false,
        value: (_success: PositionCallback, failure?: PositionErrorCallback) => {
          report('browser_permission_api', 'geolocation.getCurrentPosition');
          failure?.({ code: 1, message: denied().message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError);
        },
      });
      Object.defineProperty(geo, 'watchPosition', {
        configurable: false,
        value: (_success: PositionCallback, failure?: PositionErrorCallback) => {
          report('browser_permission_api', 'geolocation.watchPosition');
          failure?.({ code: 1, message: denied().message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError);
          return -1;
        },
      });
    }
  } catch {}

  try {
    denyAsyncMethods(navigator.clipboard, ['read', 'readText', 'write', 'writeText'], 'browser_permission_api', 'clipboard');
  } catch {}
  const navigatorCapabilities = navigator as unknown as Record<string, unknown>;
  denyAsyncMethods(navigatorCapabilities.usb, ['requestDevice'], 'browser_permission_api', 'usb');
  denyAsyncMethods(navigatorCapabilities.serial, ['requestPort'], 'browser_permission_api', 'serial');
  denyAsyncMethods(navigatorCapabilities.bluetooth, ['requestDevice'], 'browser_permission_api', 'bluetooth');
  denyAsyncMethods(navigatorCapabilities.hid, ['requestDevice'], 'browser_permission_api', 'hid');
  denyAsyncMethods(navigator.credentials, ['create', 'get', 'store', 'preventSilentAccess'], 'authentication_submission', 'credentials');
  denyAsyncMethods(navigatorCapabilities.serviceWorker, ['register'], 'network_policy', 'serviceWorker');
  denyAsyncMethods(navigator, ['share'], 'system_ui', 'navigator');

  for (const picker of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker'] as const) {
    try {
      if (typeof (globalThis as unknown as Record<string, unknown>)[picker] !== 'function') continue;
      Object.defineProperty(globalThis, picker, {
        configurable: false,
        value: async () => {
          report('system_ui', picker);
          throw denied();
        },
      });
    } catch {}
  }

  try {
    Object.defineProperty(globalThis, 'PaymentRequest', {
      configurable: false,
      value: class WithheldPaymentRequest {
        constructor() {
          report('purchase_subscription_payment', 'PaymentRequest');
          throw denied();
        }
      },
    });
  } catch {}
  for (const rtcName of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
    try {
      if (!(rtcName in globalThis)) continue;
      Object.defineProperty(globalThis, rtcName, {
        configurable: false,
        value: class WithheldPeerConnection {
          constructor() {
            report('network_policy', rtcName);
            throw denied();
          }
        },
      });
    } catch {}
  }
  try {
    Object.defineProperty(globalThis, 'open', {
      configurable: false,
      value: () => {
        report('system_ui', 'window.open');
        return null;
      },
    });
  } catch {}
  try {
    Object.defineProperty(navigator, 'registerProtocolHandler', {
      configurable: false,
      value: () => {
        report('system_ui', 'navigator.registerProtocolHandler');
        throw denied();
      },
    });
  } catch {}

  Object.defineProperty(globalThis, '__welesBrowserEvidencePolicyVersion', {
    configurable: false,
    enumerable: false,
    value: policyVersion,
    writable: false,
  });
}

function configuredTarget(): { origin: string; hostname: string; addresses: string[] } {
  const origin = String(process.env.WELES_BROWSER_EVIDENCE_TARGET_ORIGIN ?? '');
  const hostname = String(process.env.WELES_BROWSER_EVIDENCE_TARGET_HOST ?? '').toLowerCase();
  let parsedOrigin: URL;
  let addresses: unknown;
  try {
    parsedOrigin = new URL(origin);
    addresses = JSON.parse(process.env.WELES_BROWSER_EVIDENCE_TARGET_ADDRESSES_JSON ?? 'null');
  } catch {
    throw new Error('browser-evidence target network binding is missing or invalid');
  }
  if (!origin || parsedOrigin.origin !== origin || parsedOrigin.protocol !== 'https:'
      || parsedOrigin.hostname.toLowerCase() !== hostname || !hostname || !Array.isArray(addresses)
      || addresses.length === 0 || addresses.some((address) => typeof address !== 'string')) {
    throw new Error('browser-evidence target network binding is missing or invalid');
  }
  const normalizedAddresses = [...new Set(addresses)].sort();
  normalizedAddresses.forEach(assertPublicAddress);
  return { origin, hostname, addresses: normalizedAddresses };
}

function assertPublicAddress(address: string): void {
  const family = isIP(address);
  if (!family || NETWORK_BLOCK_LIST.check(address, family === 4 ? 'ipv4' : 'ipv6')) {
    throw new Error(`non-public network address denied: ${address}`);
  }
}

async function publicAddresses(hostname: string): Promise<string[]> {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  if (!normalized || Object.hasOwn(DENIED_HOSTNAMES, normalized)
      || normalized.endsWith('.localhost') || normalized.endsWith('.local') || normalized.endsWith('.internal')) {
    throw new Error(`non-public network hostname denied: ${hostname}`);
  }
  if (isIP(normalized)) {
    assertPublicAddress(normalized);
    return [normalized];
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const answers = await Promise.race([
    lookup(normalized, { all: true, verbatim: true }),
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`network hostname resolution timed out: ${hostname}`)), 3_000);
    }),
  ]).finally(() => clearTimeout(timeout));
  const addresses = [...new Set(answers.map((answer) => answer.address))].sort();
  if (addresses.length === 0) throw new Error(`network hostname has no addresses: ${hostname}`);
  addresses.forEach(assertPublicAddress);
  return addresses;
}

function sameAddresses(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((address, index) => address === right[index]);
}
export async function resolveBrowserEvidenceTarget(value: string): Promise<{
  origin: string;
  hostname: string;
  addresses: string[];
}> {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('browser-evidence target must be public HTTPS without credentials');
  }
  const addresses = await publicAddresses(url.hostname);
  return { origin: url.origin, hostname: url.hostname.toLowerCase(), addresses };
}

function attachPageEdgeGuards(context: BrowserContext, label: string): void {
  const attach = (page: Page) => {
    page.on('dialog', async (dialog) => {
      recordEdge(label, {
        category: 'browser_dialog',
        reason: 'JavaScript dialog automatically dismissed',
        source: 'browser_context',
        dialogType: safeText(dialog.type()),
        message: safeText(dialog.message()),
        url: safeText(page.url()),
      });
      await dialog.dismiss().catch(() => {});
    });
    page.on('download', async (download) => {
      recordEdge(label, {
        category: 'system_ui_download',
        reason: 'download cancelled before persistence or system UI',
        source: 'browser_context',
        suggestedFilename: safeText(download.suggestedFilename()),
        url: safeText(download.url()),
      });
      await download.cancel().catch(() => {});
    });
  };
  context.pages().forEach(attach);
  context.on('page', attach);
}

function networkEvidenceUrl(value: URL): string {
  return safeText(`${value.origin}${value.pathname}`);
}

export async function installBrowserEvidencePolicy(context: BrowserContext, label: string): Promise<void> {
  if (!enabled()) return;
  const target = configuredTarget();
  const expectedTargetAddresses = [...new Set(target.addresses)].sort();
  expectedTargetAddresses.forEach(assertPublicAddress);
  const currentTargetAddresses = await publicAddresses(target.hostname);
  if (!sameAddresses(expectedTargetAddresses, currentTargetAddresses)) {
    throw new Error('browser-evidence target DNS changed before browser policy installation');
  }
  writeBrowserEvidencePolicy(label);
  await context.clearPermissions();
  await context.routeWebSocket('**/*', (socket) => {
    recordEdge(label, {
      category: 'network_policy',
      reason: 'WebSocket transport withheld because the browser-evidence boundary permits only pinned HTTP(S)',
      source: 'browser_context',
      url: safeText(socket.url()),
    });
    socket.close();
  });
  await context.route('**/*', async (route, request) => {
    let requestedUrl: URL | null = null;
    try {
      requestedUrl = new URL(request.url());
      const isMainNavigation = request.isNavigationRequest() && request.frame().parentFrame() === null;
      if (['about:', 'blob:', 'data:'].includes(requestedUrl.protocol)) {
        if (isMainNavigation && requestedUrl.href !== 'about:blank') {
          throw new Error('non-network main-frame navigation denied');
        }
        await route.continue();
        return;
      }
      if (!['http:', 'https:'].includes(requestedUrl.protocol) || requestedUrl.username || requestedUrl.password) {
        throw new Error('non-HTTP(S) browser request denied');
      }
      if (request.method() !== 'GET' && request.method() !== 'HEAD') {
        throw new Error('anonymous browser-evidence network policy permits only GET and HEAD');
      }
      if (requestedUrl.origin !== target.origin) {
        throw new Error('browser request left the exact admitted target origin');
      }
      const addresses = await publicAddresses(target.hostname);
      if (!sameAddresses(expectedTargetAddresses, addresses)) {
        throw new Error('target DNS differs from the admitted pinned address set');
      }
      await route.continue();
    } catch (error) {
      recordEdge(label, {
        category: 'network_policy',
        reason: safeText(error instanceof Error ? error.message : String(error)),
        source: 'browser_context',
        url: requestedUrl ? networkEvidenceUrl(requestedUrl) : 'invalid-url',
      });
      await route.abort('blockedbyclient').catch(() => {});
    }
  });
  await context.exposeBinding('__welesRecordWithheldEdge', (_source, raw) => {
    const edge = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : { category: 'browser_permission_api', api: 'unknown' };
    recordEdge(label, {
      category: safeText(edge.category) || 'browser_permission_api',
      api: safeText(edge.api) || 'unknown',
      source: 'page_api',
    });
  });
  await context.addInitScript(initScript, SPIS_BROWSER_EVIDENCE_POLICY.version);
  attachPageEdgeGuards(context, label);
}

type ControlDescriptor = {
  element: ElementHandle<HTMLElement | SVGElement>;
  label: string;
  tag: string;
  type: string;
  role: string;
  active: boolean;
  href: string;
  target: string;
  download: boolean;
  ariaControls: string;
  ariaExpanded: string;
  formPresent: boolean;
  formText: string;
  formAction: string;
  formMethod: string;
  formHasPassword: boolean;
  formHasOneTimeCode: boolean;
  formHasMessage: boolean;
};

export type BrowserEvidenceToolAuthorization = {
  invoke: () => Promise<string>;
};

async function controlDescriptors(session: WSession): Promise<ControlDescriptor[]> {
  const descriptors: ControlDescriptor[] = [];
  for (const frame of (session.page.frames?.() ?? [session.page]).slice(0, 16)) {
    const locator = frame.locator(
      'button, a, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="searchbox"]',
    );
    const count = Math.min(await locator.count().catch(() => 0), 160);
    for (let index = 0; index < count; index += 1) {
      const element = await locator.nth(index).elementHandle().catch(() => null);
      if (!element) continue;
      const data = await element.evaluate((node: Element) => {
        const html = node as HTMLElement & { type?: string; href?: string; target?: string };
        const bounds = html.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) return null;
        const form = html.closest('form');
        return {
          label: [
            html.innerText,
            html.getAttribute('aria-label'),
            html.getAttribute('title'),
            html.getAttribute('name'),
            html.getAttribute('id'),
            html.getAttribute('value'),
            html.getAttribute('placeholder'),
          ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 240),
          tag: html.tagName.toLowerCase(),
          type: String(html.type ?? '').toLowerCase().slice(0, 64),
          role: String(html.getAttribute('role') ?? '').toLowerCase().slice(0, 64),
          active: document.activeElement === html,
          href: String(html.href ?? '').slice(0, 500),
          target: String(html.target ?? '').slice(0, 32),
          download: html.hasAttribute('download'),
          ariaControls: String(html.getAttribute('aria-controls') ?? '').slice(0, 120),
          ariaExpanded: String(html.getAttribute('aria-expanded') ?? '').slice(0, 16),
          formPresent: Boolean(form),
          formText: String(form?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000),
          formAction: String(form?.action ?? '').slice(0, 500),
          formMethod: String(form?.method ?? 'get').toLowerCase().slice(0, 16),
          formHasPassword: Boolean(form?.querySelector('input[type="password"]')),
          formHasOneTimeCode: Boolean(form?.querySelector('input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="code" i]')),
          formHasMessage: Boolean(form?.querySelector('textarea, input[name*="message" i], input[name*="comment" i], input[name*="reply" i]')),
        };
      }).catch(() => null);
      if (data) descriptors.push({ element, ...data });
    }
  }
  return descriptors;
}

function targetText(tool: string, args: Record<string, unknown>): string {
  const parts = [args.target, args.selector, args.text, tool === 'press_key' ? args.key : undefined];
  return parts.map(safeText).filter(Boolean).join(' ');
}

function normalizedControlText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function matchingControl(target: string, descriptors: ControlDescriptor[]): ControlDescriptor | null {
  const normalized = normalizedControlText(target);
  if (!normalized) return null;
  const matches = descriptors.filter((control) => normalizedControlText(control.label) === normalized);
  return matches.length === 1 ? matches[0] : null;
}

function classify(text: string, control: ControlDescriptor | null, pageUrl: string): { category: string; reason: string } | null {
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

function readOnlyForm(control: ControlDescriptor, pageUrl: string): boolean {
  if (!control.formPresent) return true;
  if (control.formMethod !== 'get') return false;
  try {
    return new URL(control.formAction || pageUrl, pageUrl).origin === new URL(pageUrl).origin;
  } catch {
    return false;
  }
}

function safeClick(control: ControlDescriptor, pageUrl: string): boolean {
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
  const disclosure = !control.formPresent
    && (control.tag === 'button' || control.role === 'button')
    && Boolean(control.ariaControls)
    && (control.ariaExpanded === 'true' || control.ariaExpanded === 'false')
    && (control.type === 'button' || control.type === '');
  return disclosure;
}

const ALWAYS_WITHHELD_TOOLS: Record<string, { category: string; reason: string }> = {
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

export async function enforceBrowserEvidenceToolPolicy(
  session: WSession,
  tool: string,
  args: Record<string, unknown>,
): Promise<BrowserEvidenceToolAuthorization | null> {
  if (!enabled()) return null;
  const pageUrl = safeText(session.page.url?.() ?? '');
  let decision: { category: string; reason: string } | null = ALWAYS_WITHHELD_TOOLS[tool] ?? null;
  let control: ControlDescriptor | null = null;
  let authorization: BrowserEvidenceToolAuthorization | null = null;
  const text = targetText(tool, args);

  if (!decision && tool === 'navigate') {
    try {
      const requested = new URL(String(args.url ?? ''));
      const target = configuredTarget();
      if (requested.protocol !== 'https:' || requested.username || requested.password || requested.origin !== target.origin) {
        decision = { category: 'network_policy', reason: 'navigation left the exact admitted public target origin' };
      }
    } catch {
      decision = { category: 'network_policy', reason: 'navigation URL is invalid or has no admitted target binding' };
    }
  }

  if (!decision && tool === 'press_key') {
    const key = String(args.key ?? 'Enter');
    if (Object.hasOwn(SAFE_PAGE_KEYS, key)) return null;
    decision = {
      category: key.toLowerCase() === 'enter' ? 'form_submission' : 'system_ui_keyboard',
      reason: key.toLowerCase() === 'enter'
        ? 'Enter is withheld because it can submit the active form'
        : 'keyboard chord or system-capable key withheld',
    };
  }

  if (!decision && ['click', 'js_click', 'focus', 'fill', 'type_text', 'select_option'].includes(tool)) {
    const descriptors = await controlDescriptors(session);
    control = tool === 'type_text'
      ? descriptors.find((candidate) => candidate.active) ?? null
      : matchingControl(text, descriptors);
    decision = classify(text, control, pageUrl);
    if (!decision && !control) {
      decision = { category: 'unresolved_interactive_control', reason: 'control did not resolve to one exact fresh element' };
    } else if (!decision && control && (tool === 'click' || tool === 'js_click')) {
      if (!safeClick(control, pageUrl)) {
        decision = { category: 'ambiguous_interactive_control', reason: 'control is not an explicit same-origin link, tab, disclosure, or safe cancellation control' };
      } else {
        authorization = { invoke: async () => {
          await control!.element.click();
          return `clicked exact browser-evidence control: ${safeText(control!.label)}`;
        } };
      }
    } else if (!decision && control && tool === 'focus') {
      authorization = { invoke: async () => {
        await control!.element.focus();
        return `focused exact browser-evidence control: ${safeText(control!.label)}`;
      } };
    } else if (!decision && control && (tool === 'fill' || tool === 'type_text')) {
      const searchControl = (control.type === 'search' || control.role === 'searchbox')
        && readOnlyForm(control, pageUrl);
      if (!searchControl || typeof args.value !== 'string') {
        decision = { category: 'ambiguous_input_control', reason: 'only exact read-only GET search/filter inputs are permitted' };
      } else {
        authorization = { invoke: async () => {
          if (tool === 'fill') await control!.element.fill(String(args.value));
          else await control!.element.type(String(args.value));
          return `updated exact read-only search control: ${safeText(control!.label)}`;
        } };
      }
    } else if (!decision && control && tool === 'select_option') {
      const filterControl = control.tag === 'select'
        && /\b(?:filter|sort|search)\b/i.test(control.label)
        && readOnlyForm(control, pageUrl);
      if (!filterControl || typeof args.value !== 'string') {
        decision = { category: 'ambiguous_input_control', reason: 'only exact read-only GET filter selections are permitted' };
      } else {
        authorization = { invoke: async () => {
          await control!.element.selectOption(String(args.value));
          return `updated exact read-only filter control: ${safeText(control!.label)}`;
        } };
      }
    }
  }

  if (!decision) return authorization;
  recordEdge(session.label, {
    category: decision.category,
    reason: decision.reason,
    source: 'tool_dispatch',
    tool,
    target: text,
    url: pageUrl,
    control: control ? {
      label: safeText(control.label),
      type: safeText(control.type),
      role: safeText(control.role),
      href: safeText(control.href),
      formAction: safeText(control.formAction),
    } : null,
  });
  throw new Error(`policy_withheld:${decision.category}:${decision.reason}`);
}
