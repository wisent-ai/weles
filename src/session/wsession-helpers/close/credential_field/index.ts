// Which page field may receive a credential: found by the markup its class
// declares, by its label, or by the explicit selector the target names, and
// refused unless its own markup declares the class. Split out of
// credential_fill.ts, which keeps the capability redemption and the fill.
import type { ElementHandle, Page } from 'playwright';
import { resolveObservedControl } from '../../../observation/controls.js';

export type CredentialFieldClass =
  | 'password'
  | 'email'
  | 'username'
  | 'token'
  | 'api-key';

/**
 * What a field's own markup must declare to receive each credential class:
 * its input type, or a WHATWG autocomplete field name
 * (https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill).
 * The page states what a field takes in its markup, whatever language its
 * label is in. A secret goes only into a field that masks it; email and
 * username are not secret, so any plain text input may take them too.
 */
interface DeclaredControl {
  types: Record<string, true>;
  autocomplete: Record<string, true>;
  plainText: boolean;
}

const CREDENTIAL_CONTROLS: Record<CredentialFieldClass, DeclaredControl> = {
  password: { types: { password: true }, autocomplete: {}, plainText: false },
  email: {
    types: { email: true },
    autocomplete: { email: true, username: true },
    plainText: true,
  },
  username: {
    types: {},
    autocomplete: { username: true, nickname: true, email: true },
    plainText: true,
  },
  token: {
    types: { password: true },
    autocomplete: { 'one-time-code': true },
    plainText: false,
  },
  'api-key': { types: { password: true }, autocomplete: {}, plainText: false },
};

/** The selectors that find a field declaring this class. */
function declaredSelectors(fieldClass: CredentialFieldClass): string[] {
  const declared = CREDENTIAL_CONTROLS[fieldClass];
  return [
    ...Object.keys(declared.types).map((type) => `input[type="${type}"]`),
    ...Object.keys(declared.autocomplete).map(
      (name) => `input[autocomplete~="${name}" i]`,
    ),
  ];
}

/** What a control's own markup states: its input type, or its tag for any
 * other element, and its WHATWG autocomplete field names. */
interface Markup {
  type: string;
  autocomplete: string[];
}

async function markup(control: ElementHandle): Promise<Markup> {
  // A handle may name any DOM node; a text or comment node has no markup to
  // declare a credential class, so it is refused with what it is.
  return control.evaluate((node) => {
    if (!(node instanceof Element)) {
      throw new Error(
        `the bound control is a ${node.nodeName} node, not an element`,
      );
    }
    return {
      type:
        node instanceof HTMLInputElement
          ? node.type
          : node.tagName.toLowerCase(),
      autocomplete: node.hasAttribute('autocomplete')
        ? String(node.getAttribute('autocomplete')).toLowerCase().split(/\s+/)
        : [],
    };
  });
}

/** Whether `seen` declares `fieldClass` by its input type or autocomplete. */
function declares(seen: Markup, fieldClass: CredentialFieldClass): boolean {
  const declared = CREDENTIAL_CONTROLS[fieldClass];
  return (
    Object.hasOwn(declared.types, seen.type) ||
    seen.autocomplete.some((name) => Object.hasOwn(declared.autocomplete, name))
  );
}

/**
 * Refuses, before any capability is redeemed, a bound field whose own markup
 * does not declare the class, naming what the field does declare.
 */
export async function assertDeclaredControl(
  control: ElementHandle,
  fieldClass: CredentialFieldClass,
  target: string,
): Promise<void> {
  const seen = await markup(control);
  const declared = CREDENTIAL_CONTROLS[fieldClass];
  const fits =
    declares(seen, fieldClass) || (declared.plainText && seen.type === 'text');
  if (!fits)
    throw new Error(
      `[credential_target_mismatch] ${JSON.stringify(target)} is a ${seen.type} control with autocomplete ${JSON.stringify(seen.autocomplete)}; a ${fieldClass} goes only into a field whose markup declares input type ${JSON.stringify(Object.keys(declared.types))} or autocomplete ${JSON.stringify(Object.keys(declared.autocomplete))}${declared.plainText ? ' or into a plain text input' : ''}. The capability was not consumed`,
    );
}

/**
 * Refuses literal input into a control whose own markup declares a
 * credential class, by the same reading a credential fill is judged by: a
 * field that takes a password, token, key, e-mail or username takes it only
 * through fill_credential, whatever words its target is described in.
 */
export async function assertLiteralControl(
  control: ElementHandle,
): Promise<void> {
  const seen = await markup(control);
  const fieldClass = (
    Object.keys(CREDENTIAL_CONTROLS) as CredentialFieldClass[]
  ).find((candidate) => declares(seen, candidate));
  if (fieldClass !== undefined)
    throw new Error(
      `[credential_target] a ${seen.type} control with autocomplete ${JSON.stringify(seen.autocomplete)} declares a ${fieldClass} field; credential fields require fill_credential with a capability reference`,
    );
}

// Resolve and retain the exact node before redeeming. The old presence probe
// and generic fill used different selectors and could fall back to a visual
// guess after the one-shot capability had already been spent. Words of the
// target are not matched against names and placeholders either: that put a
// credential into whichever field happened to share a word with the target's
// description. A target that opens with a CSS type selector and its attribute
// selectors (`input[name="pass"] ...`) names its field by that selector; the
// markup check above still decides whether the field may take the class.
export async function credentialField(
  page: Page,
  target: string,
  allowedOrigin: string,
  fieldClass: CredentialFieldClass,
): Promise<ElementHandle | null> {
  const observed = await resolveObservedControl(page, target, allowedOrigin);
  if (observed) return observed;
  const explicitSelector = target
    .trim()
    .match(/^[a-z]+(?:\[[^\]]+\])+/i)
    ?.shift();
  const frames = page
    .frames()
    .filter((frame) => new URL(frame.url()).origin === allowedOrigin);
  const queries = explicitSelector
    ? [explicitSelector]
    : [null, ...declaredSelectors(fieldClass)];
  for (const selector of queries) {
    let handles: ElementHandle[] = [];
    let selected: ElementHandle | null = null;
    try {
      for (const frame of frames) {
        const locator = selector
          ? frame.locator(selector)
          : frame.getByLabel(target, { exact: false });
        handles.push(...(await locator.elementHandles()));
      }
      for (const handle of handles) {
        if (!(await handle.isVisible()) || !(await handle.isEditable()))
          continue;
        if (selected)
          throw new Error(
            `[credential_target_ambiguous] Multiple editable fields match ${JSON.stringify(target)}; capability not consumed`,
          );
        selected = handle;
      }
      if (selected) {
        const kept = selected;
        handles = handles.filter((handle) => handle !== kept);
        return kept;
      }
    } finally {
      await Promise.all(handles.map((handle) => handle.dispose()));
    }
  }
  return null;
}
