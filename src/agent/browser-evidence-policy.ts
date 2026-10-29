// The browser-evidence policy as the rest of the workshop meets it: what gets
// installed on a browser context before a run may use it. The declaration and
// its ledger, the page APIs a run may not reach, the pinned network target and
// the admission of tool calls against interactive controls
// (interactive-control/tool-dispatch.ts) live beside this file, because each
// of them changes for its own reasons.
import type { BrowserContext } from 'playwright';
import { initScript } from './browser-evidence-policy/page-api-withholding.js';
import {
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
  receiveWithheldEdge,
  recordEdge,
  safeText,
  writeBrowserEvidencePolicy,
} from './browser-evidence-policy/withheld-ledger.js';
import { attachPageEdgeGuards } from './browser-evidence-policy/page-edge-guards.js';
import { loadSpecialAddresses } from '../proxy/quality/special-addresses.js';

/**
 * Whether `method` reads without changing anything: one the platform's own
 * fetch refuses to send a body with (GET and HEAD); a forbidden one throws.
 */
function readOnlyMethod(method: string): boolean {
  new Request('https://method.invalid/', { method });
  let refusedBody: unknown;
  try {
    new Request('https://method.invalid/', { method, body: 'probe' });
  } catch (error) {
    refusedBody = error;
  }
  return refusedBody instanceof TypeError;
}

export async function installBrowserEvidencePolicy(
  context: BrowserContext,
  label: string,
): Promise<void> {
  if (!enabled()) return;
  await loadSpecialAddresses();
  const target = configuredTarget();
  const expectedTargetAddresses = target.addresses;
  const currentTargetAddresses = await publicAddresses(target.hostname);
  if (!sameAddresses(expectedTargetAddresses, currentTargetAddresses)) {
    throw new Error(
      'browser-evidence target DNS changed before browser policy installation',
    );
  }
  writeBrowserEvidencePolicy(label);
  await context.clearPermissions();
  await context.routeWebSocket('**/*', (socket) => {
    recordEdge(label, {
      category: 'network_policy',
      reason:
        'WebSocket transport withheld because the browser-evidence boundary permits only pinned HTTP(S)',
      source: 'browser_context',
      url: safeText(socket.url()),
    });
    socket.close();
  });
  // The request's address as the ledger keeps it, or the raw one it could not parse.
  const evidenceUrl = (raw: string) =>
    URL.canParse(raw)
      ? networkEvidenceUrl(new URL(raw))
      : `unparsable: ${safeText(raw)}`;
  await context.route('**/*', async (route, request) => {
    try {
      const requestedUrl = new URL(request.url());
      const isMainNavigation =
        request.isNavigationRequest() && request.frame().parentFrame() === null;
      if (['about:', 'blob:', 'data:'].includes(requestedUrl.protocol)) {
        if (isMainNavigation && requestedUrl.href !== 'about:blank') {
          throw new Error('non-network main-frame navigation denied');
        }
        await route.continue();
        return;
      }
      if (
        !['http:', 'https:'].includes(requestedUrl.protocol) ||
        requestedUrl.username ||
        requestedUrl.password
      ) {
        throw new Error('non-HTTP(S) browser request denied');
      }
      if (!readOnlyMethod(request.method()))
        throw new Error(
          'anonymous browser-evidence network policy permits only methods that carry no body (GET and HEAD)',
        );
      if (requestedUrl.origin !== target.origin)
        throw new Error(
          'browser request left the exact admitted target origin',
        );
      if (
        !sameAddresses(
          expectedTargetAddresses,
          await publicAddresses(target.hostname),
        )
      )
        throw new Error(
          'target DNS differs from the admitted pinned address set',
        );
      await route.continue();
    } catch (error) {
      recordEdge(label, {
        category: 'network_policy',
        reason: describeEdgeFailure(error),
        source: 'browser_context',
        url: evidenceUrl(request.url()),
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
          url: evidenceUrl(request.url()),
        });
      }
    }
  });
  await context.exposeBinding('__welesRecordWithheldEdge', (_source, raw) =>
    receiveWithheldEdge(label, raw),
  );
  await context.addInitScript(initScript, SPIS_BROWSER_EVIDENCE_POLICY.version);
  attachPageEdgeGuards(context, label);
}
