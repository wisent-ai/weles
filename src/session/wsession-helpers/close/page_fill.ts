/**
 * Filling a field on a WSession page: the frames a fill may reach, the first
 * visible control a locator names, and the fill itself.
 */

import type { Frame, Locator } from 'playwright';
import { assertNonCredentialInput } from '../../../utils/capability.js';
import { humanClick } from '../../../human/mouse.js';
import { humanFill, humanType } from '../../../human/keyboard.js';
import {
  findClickTarget,
  type ScreenshottablePage,
} from '../../../vision/analyze.js';
import type { WSession } from '../../wsession.js';
import { assertLiteralControl } from './credential_field/index.js';
import { assertFocusedLiteralInput } from '../../wsession/page-actions.js';

const asV = (p: any) => p as unknown as ScreenshottablePage;

// A WSession page is a Playwright page (launched or connected over CDP by
// browser-launch.ts), so frames, URLs and locators are read through
// Playwright's methods.
export function childFrames(s: WSession, allowedOrigin?: string): Frame[] {
  const mainFrame = s.page.mainFrame();
  return (s.page.frames() as Frame[]).filter((frame) => {
    // The main frame is searched separately; a frame the page has already
    // detached (an ad or widget torn down mid-navigation) holds no control.
    if (frame === mainFrame || frame.isDetached()) return false;
    if (!allowedOrigin) return true;
    // A frame without a parsable URL (about:srcdoc) belongs to no origin.
    const url = frame.url();
    return URL.canParse(url) ? new URL(url).origin === allowedOrigin : false;
  });
}

/**
 * The first visible control `loc` names, or null when none is visible. A
 * locator that cannot be queried (a closed page, a malformed selector) is not
 * one without a match: its error reaches the caller instead of sending the
 * fill or click on to a label, keyword or vision guess.
 */
export async function firstVisible(
  loc: Locator | undefined,
): Promise<Locator | null> {
  if (!loc) return null;
  const first = loc.first();
  return (await first.isVisible()) ? first : null;
}

export async function fillPage(
  s: WSession,
  target: string,
  value: string,
  allowedOrigin?: string,
  credentialAuthorized = false,
): Promise<string> {
  if (typeof target !== 'string' || !target.trim())
    throw new Error(
      '[target_empty] A fill requires a non-empty target; no input was sent',
    );
  const fill = async (control: Locator) => {
    if (credentialAuthorized) {
      await humanFill(s.page, control, value);
      return;
    }
    const element = await control.elementHandle();
    if (!element)
      throw new Error(
        '[input_target_stale] The field disappeared before literal input',
      );
    try {
      await assertLiteralControl(element);
      await humanFill(s.page, element, value);
    } finally {
      await element.dispose();
    }
  };
  // A target that opens with a CSS type selector and its attribute selectors
  // names its field by that selector. Otherwise the field is the one its label
  // (or aria-label) names, then the one whose placeholder holds the target,
  // then the one vision finds. Words of the target are not matched against
  // field names: that filled whichever field shared a word with the target.
  const explicitSelector = target
    .trim()
    .match(/^[a-z]+(?:\[[^\]]+\])+/i)
    ?.shift();
  for (const frame of [...childFrames(s, allowedOrigin), s.page]) {
    if (explicitSelector) {
      const explicit = await firstVisible(frame.locator?.(explicitSelector));
      if (explicit) {
        await fill(explicit);
        return `filled ${explicitSelector}`;
      }
    }
    const label = await firstVisible(
      frame.getByLabel?.(target, { exact: false }),
    );
    if (label) {
      await fill(label);
      return 'filled label';
    }
    const placeholder = await firstVisible(
      frame.getByPlaceholder?.(target, { exact: false }),
    );
    if (placeholder) {
      await fill(placeholder);
      return 'filled placeholder';
    }
  }
  const point = await findClickTarget(asV(s.page), target);
  if (!point) return 'no-field-found';
  await humanClick(s.page, point.x, point.y);
  if (!credentialAuthorized) await assertFocusedLiteralInput(s);
  // Typing after a failed select-all appends to whatever the field held, so
  // the field would be submitted with a value nobody asked for.
  await s.page.keyboard.press('Meta+a').catch((error: unknown) => {
    throw new Error(
      `could not select the existing text of ${target} before typing: ${error}`,
    );
  });
  await humanType(s.page, value);
  return 'filled';
}

export async function wsFill(
  s: WSession,
  target: string,
  value: string,
): Promise<string> {
  const pageUrl = new URL(s.page.url());
  if (!/^https?:$/.test(pageUrl.protocol))
    throw new Error('fill requires an HTTP(S) origin');
  const literal = assertNonCredentialInput(value);
  return s.runStep(`fill_${target}`, () =>
    fillPage(s, target, literal, pageUrl.origin),
  );
}
