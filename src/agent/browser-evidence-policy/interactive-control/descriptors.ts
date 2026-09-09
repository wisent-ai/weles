// What the interactive controls on the page actually are, read fresh from every
// frame a run can see. Nothing here decides anything; it answers only "which
// controls exist right now, and what does each one say about itself". A frame or
// a control that could not be read is not treated as absent: it gets its own
// named edge in the withheld ledger, so a refusal caused by a page nobody could
// read is distinguishable from a refusal caused by a control that was not there.
import type { ElementHandle } from 'playwright';
import type { WSession } from '../../../session/wsession.js';
import { describeEdgeFailure, recordEdge, safeText } from '../withheld-ledger.js';

// Everything except the handle arrives from a single in-page evaluation, so the
// facts are named apart from the handle they belong to. An attribute the node
// does not carry stays absent instead of arriving as empty text: `role`,
// `ariaControls` and `ariaExpanded` are undefined exactly when the attribute is
// missing, and every reader below branches on that rather than on a blank.
type ControlFacts = {
  label: string;
  tag: string;
  type: string;
  role: string | undefined;
  active: boolean;
  href: string;
  target: string;
  download: boolean;
  ariaControls: string | undefined;
  ariaExpanded: string | undefined;
  formPresent: boolean;
  formText: string;
  formAction: string;
  formMethod: string;
  formHasPassword: boolean;
  formHasOneTimeCode: boolean;
  formHasMessage: boolean;
};

export type ControlDescriptor = ControlFacts & {
  element: ElementHandle<HTMLElement | SVGElement>;
};

export async function controlDescriptors(session: WSession): Promise<ControlDescriptor[]> {
  const descriptors: ControlDescriptor[] = [];
  for (const frame of (session.page.frames?.() ?? [session.page]).slice(0, 16)) {
    const locator = frame.locator(
      'button, a, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="searchbox"]',
    );
    let count: number;
    try {
      count = Math.min(await locator.count(), 160);
    } catch (error) {
      recordEdge(session.label, {
        category: 'unreadable_interactive_frame',
        reason: `interactive controls of this frame could not be counted: ${describeEdgeFailure(error)}`,
        source: 'tool_dispatch',
        url: safeText(frame.url?.() ?? ''),
      });
      continue;
    }
    for (let index = 0; index < count; index += 1) {
      let element: ElementHandle<HTMLElement | SVGElement> | null;
      try {
        element = await locator.nth(index).elementHandle();
      } catch (error) {
        recordEdge(session.label, {
          category: 'unreadable_interactive_control',
          reason: `no handle could be taken for interactive control #${index} of this frame: ${describeEdgeFailure(error)}`,
          source: 'tool_dispatch',
          url: safeText(frame.url?.() ?? ''),
        });
        continue;
      }
      if (!element) continue;
      let facts: ControlFacts | null;
      try {
        facts = await element.evaluate((node: Element) => {
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
            role: html.getAttribute('role')?.toLowerCase().slice(0, 64),
            active: document.activeElement === html,
            href: String(html.href ?? '').slice(0, 500),
            target: String(html.target ?? '').slice(0, 32),
            download: html.hasAttribute('download'),
            ariaControls: html.getAttribute('aria-controls')?.slice(0, 120),
            ariaExpanded: html.getAttribute('aria-expanded')?.slice(0, 16),
            formPresent: Boolean(form),
            formText: String(form?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000),
            formAction: String(form?.action ?? '').slice(0, 500),
            formMethod: String(form?.method ?? 'get').toLowerCase().slice(0, 16),
            formHasPassword: Boolean(form?.querySelector('input[type="password"]')),
            formHasOneTimeCode: Boolean(form?.querySelector('input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="code" i]')),
            formHasMessage: Boolean(form?.querySelector('textarea, input[name*="message" i], input[name*="comment" i], input[name*="reply" i]')),
          };
        });
      } catch (error) {
        recordEdge(session.label, {
          category: 'unreadable_interactive_control',
          reason: `interactive control #${index} of this frame could not be read: ${describeEdgeFailure(error)}`,
          source: 'tool_dispatch',
          url: safeText(frame.url?.() ?? ''),
        });
        continue;
      }
      // A null here is the page's own answer that the node has no box on
      // screen, which is a different fact from the read failures above.
      if (facts) descriptors.push({ element, ...facts });
    }
  }
  return descriptors;
}
