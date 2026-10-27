/**
 * The US keyboard as Playwright declares it for the Chromium it drives: each
 * key's code, key, Windows virtual key code, text, location and shifted key,
 * read from the installed playwright-core (lib/server/usKeyboardLayout), with
 * the aliases Playwright gives them (Shift, Control, Alt and Meta for the left
 * keys; "\n" and "\r" for Enter), and the DevTools-protocol modifier mask
 * Playwright sends (lib/server/chromium/crProtocolHelper toModifiersMask).
 * Weles declares no key code or modifier bit of its own.
 */

import { dirname, join } from 'node:path';

type KeyDefinition = {
  keyCode: number;
  keyCodeWithoutLocation?: number;
  shiftKeyCode?: number;
  key: string;
  shiftKey?: string;
  text?: string;
  location?: number;
};

/** What Input.dispatchKeyEvent is told about one key. */
export type KeyDescription = {
  code: string;
  key: string;
  windowsVirtualKeyCode: number;
  text: string | undefined;
  location: number | undefined;
  shifted: KeyDescription | undefined;
};

// Weles compiles to CommonJS (tsconfig module Node18, no "type": "module"),
// so the module's own require resolves playwright-core; import.meta is not
// there to build another one from.
const server = join(
  dirname(require.resolve('playwright-core/package.json')),
  'lib',
  'server',
);
const { USKeyboardLayout, keypadLocation } = require(
  join(server, 'usKeyboardLayout.js'),
) as { USKeyboardLayout: Record<string, KeyDefinition>; keypadLocation: number };
const { toModifiersMask } = require(
  join(server, 'chromium', 'crProtocolHelper.js'),
) as { toModifiersMask: (held: Set<string>) => number };

/** The location Playwright gives the numeric keypad's keys. */
export const KEYPAD_LOCATION = keypadLocation;

/** The keys the protocol counts as modifiers, by their key name. */
export const MODIFIERS: ReadonlySet<string> = new Set([
  'Alt',
  'Control',
  'Meta',
  'Shift',
]);

const ALIASES: Readonly<Record<string, readonly string[]>> = {
  ShiftLeft: ['Shift'],
  ControlLeft: ['Control'],
  AltLeft: ['Alt'],
  MetaLeft: ['Meta'],
  Enter: ['\n', '\r'],
};

const printable = (key: string): boolean => /^.$/u.test(key);

const LAYOUT = new Map<string, KeyDescription>();
for (const [code, definition] of Object.entries(USKeyboardLayout)) {
  const plain: KeyDescription = {
    code,
    key: definition.key,
    windowsVirtualKeyCode:
      definition.keyCodeWithoutLocation ?? definition.keyCode,
    text: printable(definition.key) ? definition.key : definition.text,
    location: definition.location,
    shifted: undefined,
  };
  const shifted: KeyDescription | undefined =
    definition.shiftKey === undefined
      ? undefined
      : {
          ...plain,
          key: definition.shiftKey,
          text: definition.shiftKey,
          windowsVirtualKeyCode:
            definition.shiftKeyCode ?? plain.windowsVirtualKeyCode,
        };
  LAYOUT.set(code, { ...plain, shifted });
  if (Object.hasOwn(ALIASES, code))
    for (const alias of ALIASES[code]) LAYOUT.set(alias, plain);
  if (definition.location !== undefined) continue;
  if (printable(plain.key)) LAYOUT.set(plain.key, plain);
  if (shifted) LAYOUT.set(shifted.key, shifted);
}

/** Whether the layout names `key` (a code, a key, or an alias). */
export function onLayout(key: string): boolean {
  return LAYOUT.has(key);
}

/** The description of `key`; a key the layout does not name is refused. */
export function keyDescription(key: string): KeyDescription {
  const described = LAYOUT.get(key);
  if (!described)
    throw new Error(
      `the US keyboard layout names no key ${JSON.stringify(key)}; type it as text instead`,
    );
  return described;
}

/** The protocol's modifier mask for the modifiers held. */
export function modifiersMask(held: ReadonlySet<string>): number {
  return toModifiersMask(new Set(held));
}
