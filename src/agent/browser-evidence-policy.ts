// The browser-evidence policy as the rest of the workshop meets it: what gets
// installed on a browser context before a run may use it, and whether one tool
// call against that context is authorized. The declaration and its ledger, the
// page APIs a run may not reach, the pinned network target and the reading of
// interactive controls live beside this file, because each of them changes for
// its own reasons; the two decisions below are what callers actually ask for.
import type { BrowserContext, Page } from 'playwright';
import type { WSession } from '../session/wsession.js';
import type { ControlDescriptor } from './browser-evidence-policy/interactive-control/descriptors.js';
import { controlDescriptors } from './browser-evidence-policy/interactive-control/descriptors.js';
import {
  ALWAYS_WITHHELD_TOOLS,
  SAFE_PAGE_KEYS,
  classify,
  matchingControl,
  readOnlyForm,
  safeClick,
  targetText,
} from './browser-evidence-policy/interactive-control/admission.js';
import { initScript } from './browser-evidence-policy/page-api-withholding.js';
import {
  assertPublicAddress,
  configuredTarget,
  networkEvidenceUrl,
  publicAddresses,
  resolveBrowserEvidenceTarget,
  sameAddresses,
} from './browser-evidence-policy/pinned-network.js';
import {
  SPIS_BROWSER_EVIDENCE_POLICY,
  describeEdgeFailure,
  enabled,
  recordEdge,
  safeText,
  writeBrowserEvidencePolicy,
} from './browser-evidence-policy/withheld-ledger.js';

export { SPIS_BROWSER_EVIDENCE_POLICY, resolveBrowserEvidenceTarget, writeBrowserEvidencePolicy };

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
      try {
        await dialog.dismiss();
      } catch (error) {
        // A dialog that would not close is a state of the page, not a
        // non-event: the run continues against a page that still holds a modal,
        // so the ledger says so beside the dismissal edge above.
        recordEdge(label, {
          category: 'browser_dialog_undismissed',
          reason: `JavaScript dialog stayed open because dismissal failed: ${describeEdgeFailure(error)}`,
          source: 'browser_context',
          dialogType: safeText(dialog.type()),
          message: safeText(dialog.message()),
          url: safeText(page.url()),
        });
      }
    });
    page.on('download', async (download) => {
      recordEdge(label, {
        category: 'system_ui_download',
        reason: 'download cancelled before persistence or system UI',
        source: 'browser_context',
        suggestedFilename: safeText(download.suggestedFilename()),
        url: safeText(download.url()),
      });
      try {
        await download.cancel();
      } catch (error) {
        // The cancellation edge above claims the download never persisted. If
        // the cancellation itself failed, that claim is withdrawn here by name.
        recordEdge(label, {
          category: 'system_ui_download_uncancelled',
          reason: `download was not cancelled: ${describeEdgeFailure(error)}`,
          source: 'browser_context',
          suggestedFilename: safeText(download.suggestedFilename()),
          url: safeText(download.url()),
        });
      }
    });
  };
  context.pages().forEach(attach);
  context.on('page', attach);
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
        reason: describeEdgeFailure(error),
        source: 'browser_context',
        url: requestedUrl ? networkEvidenceUrl(requestedUrl) : 'invalid-url',
      });
      try {
        await route.abort('blockedbyclient');
      } catch (abortError) {
        // A refusal that could not be delivered leaves the request in the
        // browser's hands, so the ledger keeps both facts: what was refused and
        // why the refusal never reached the request.
        recordEdge(label, {
          category: 'network_policy_unenforced',
          reason: `request refusal was not delivered: ${describeEdgeFailure(abortError)}; the refusal was: ${describeEdgeFailure(error)}`,
          source: 'browser_context',
          url: requestedUrl ? networkEvidenceUrl(requestedUrl) : 'invalid-url',
        });
      }
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

export type BrowserEvidenceToolAuthorization = {
  invoke: () => Promise<string>;
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
