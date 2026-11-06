/**
 * Raw DevTools-protocol input for a CDPPage. The pointer travels along a
 * segment of the operator's harvested pointer trace (src/human/trace.ts),
 * carried onto the wanted start and end, with no invented curve or jitter; a
 * press counts the presses made since the pointer last moved, as the OS
 * counts them. Keys are described by the US layout Playwright declares
 * (./input/keyboard-layout.ts).
 */

import { CDPConnection } from './connection.js';
import { recordedApproach, replayedPath } from '../human/trace.js';
import type { Point } from '../human/pointer/trace-file.js';
import {
  KEYPAD_LOCATION,
  MODIFIERS,
  keyDescription,
  modifiersMask,
  onLayout,
} from './input/keyboard-layout.js';

/** The protocol's mouse buttons a press can name. */
export type MouseButton = 'left' | 'middle' | 'right';

/** Whether the run asked for single-event moves (WELES_INSTANT_INPUT=1). */
function instantMode(): boolean {
  return process.env.WELES_INSTANT_INPUT === '1';
}

export class CDPMouse {
  private _conn: CDPConnection;
  private _sessionId: string;
  private _at: Point | undefined;
  // The buttons pressed since the pointer last moved; a press's click count.
  private _presses: MouseButton[] = [];

  constructor(connection: CDPConnection, sessionId: string) {
    this._conn = connection;
    this._sessionId = sessionId;
  }

  private _where(what: string): Point {
    if (!this._at)
      throw new Error(
        `a mouse ${what} needs the pointer moved onto the page first`,
      );
    return this._at;
  }

  private async _moved(at: Point): Promise<void> {
    await this._conn.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: at.x, y: at.y },
      this._sessionId,
    );
  }

  /** Move to (x, y) along a recorded segment, or in one event when instant. */
  async move(
    x: number,
    y: number,
    options?: { instant?: boolean },
  ): Promise<void> {
    const to = { x, y };
    const instant = options?.instant ?? instantMode();
    if (instant) await this._moved(to);
    else {
      const from = this._at ? this._at : recordedApproach(to);
      for (const at of replayedPath(from, to)) await this._moved(at);
    }
    this._at = to;
    this._presses = [];
  }

  async down(button: MouseButton): Promise<void> {
    const at = this._where('press');
    this._presses.push(button);
    await this._conn.send(
      'Input.dispatchMouseEvent',
      {
        type: 'mousePressed',
        button,
        x: at.x,
        y: at.y,
        clickCount: this._presses.length,
      },
      this._sessionId,
    );
  }

  async up(button: MouseButton): Promise<void> {
    const at = this._where('release');
    await this._conn.send(
      'Input.dispatchMouseEvent',
      {
        type: 'mouseReleased',
        button,
        x: at.x,
        y: at.y,
        clickCount: this._presses.length,
      },
      this._sessionId,
    );
  }

  async click(
    x: number,
    y: number,
    button: MouseButton,
    options?: { instant?: boolean },
  ): Promise<void> {
    await this.move(x, y, options);
    await this.down(button);
    await this.up(button);
  }

  /** Two presses at (x, y) without moving between them: counts one, then two. */
  async dblclick(x: number, y: number, button: MouseButton): Promise<void> {
    await this.click(x, y, button);
    await this.down(button);
    await this.up(button);
  }

  async wheel(deltaX: number, deltaY: number): Promise<void> {
    const at = this._where('wheel');
    await this._conn.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseWheel', x: at.x, y: at.y, deltaX, deltaY },
      this._sessionId,
    );
  }
}

/** Modifiers that leave a key's text as typed. */
const TEXT_KEEPING: ReadonlySet<string> = new Set(['Shift']);

/** Playwright's alias for the platform's primary shortcut modifier. */
const CONTROL_OR_META = 'ControlOrMeta';

/** What Chromium's own user agent names a macOS host by. */
const MAC_USER_AGENT = 'Macintosh';

/**
 * The keys of a chord, split on `+` the way Playwright splits them: a `+`
 * that starts a token is the key itself, so `Shift++` is Shift then `+`.
 */
function chord(keys: string): string[] {
  const parts: string[] = [];
  let part = '';
  for (const char of keys) {
    if (char === '+' && part) {
      parts.push(part);
      part = '';
    } else part += char;
  }
  parts.push(part);
  return parts;
}

export class CDPKeyboard {
  private _conn: CDPConnection;
  private _sessionId: string;
  private readonly _held = new Set<string>();
  /** Whether the driven browser runs on macOS, asked once. */
  private _mac?: Promise<boolean>;

  constructor(connection: CDPConnection, sessionId: string) {
    this._conn = connection;
    this._sessionId = sessionId;
  }

  async down(key: string): Promise<void> {
    const described = keyDescription(key);
    const pressed =
      this._held.has('Shift') && described.shifted
        ? described.shifted
        : described;
    const typed = [...this._held].every((held) => TEXT_KEEPING.has(held))
      ? pressed.text
      : undefined;
    if (MODIFIERS.has(pressed.key)) this._held.add(pressed.key);
    await this._conn.send(
      'Input.dispatchKeyEvent',
      {
        type: typed ? 'keyDown' : 'rawKeyDown',
        modifiers: modifiersMask(this._held),
        windowsVirtualKeyCode: pressed.windowsVirtualKeyCode,
        code: pressed.code,
        key: pressed.key,
        text: typed,
        unmodifiedText: typed,
        location: pressed.location,
        isKeypad: pressed.location === KEYPAD_LOCATION,
      },
      this._sessionId,
    );
  }

  async up(key: string): Promise<void> {
    const released = keyDescription(key);
    this._held.delete(released.key);
    await this._conn.send(
      'Input.dispatchKeyEvent',
      {
        type: 'keyUp',
        modifiers: modifiersMask(this._held),
        key: released.key,
        windowsVirtualKeyCode: released.windowsVirtualKeyCode,
        code: released.code,
        location: released.location,
      },
      this._sessionId,
    );
  }

  /**
   * Press `key`, or a chord written as Playwright writes it (`Control+A`,
   * `ControlOrMeta+K`, `Shift++`): each modifier goes down in order, the
   * last key is pressed, and the keys come up in reverse. Every key is
   * described before any event is sent, so an unknown key refuses the whole
   * chord. A modifier the caller already holds stays held afterwards.
   * `ControlOrMeta` is Meta when the driven browser runs on macOS.
   */
  async press(key: string): Promise<void> {
    const keys = await Promise.all(
      chord(key).map((part) => this._resolve(part)),
    );
    for (const part of keys) keyDescription(part);
    const pressed: string[] = [];
    for (const part of keys) {
      const described = keyDescription(part);
      if (MODIFIERS.has(described.key) && this._held.has(described.key))
        continue;
      await this.down(part);
      pressed.push(part);
    }
    for (const part of pressed.reverse()) await this.up(part);
  }

  private _resolve(key: string): Promise<string> {
    if (key !== CONTROL_OR_META) return Promise.resolve(key);
    this._mac ??= this._conn
      .send('Browser.getVersion', {})
      .then((version: { userAgent: string }) =>
        version.userAgent.includes(MAC_USER_AGENT),
      );
    return this._mac.then((mac) => (mac ? 'Meta' : 'Control'));
  }

  /** Each character on the layout is pressed; any other is inserted as text. */
  async type(text: string): Promise<void> {
    for (const char of text) {
      if (onLayout(char)) await this.press(char);
      else await this.insertText(char);
    }
  }

  async insertText(text: string): Promise<void> {
    await this._conn.send('Input.insertText', { text }, this._sessionId);
  }
}
