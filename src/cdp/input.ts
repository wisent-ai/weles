import { CDPConnection } from './connection.js';

const KEY_DEFS: Record<string, [number, string, string]> = {
  Enter:      [13,  'Enter',       'Enter'],
  Tab:        [9,   'Tab',         'Tab'],
  Backspace:  [8,   'Backspace',   'Backspace'],
  Delete:     [46,  'Delete',      'Delete'],
  Escape:     [27,  'Escape',      'Escape'],
  ArrowUp:    [38,  'ArrowUp',     'ArrowUp'],
  ArrowDown:  [40,  'ArrowDown',   'ArrowDown'],
  ArrowLeft:  [37,  'ArrowLeft',   'ArrowLeft'],
  ArrowRight: [39,  'ArrowRight',  'ArrowRight'],
  Home:       [36,  'Home',        'Home'],
  End:        [35,  'End',         'End'],
  PageUp:     [33,  'PageUp',      'PageUp'],
  PageDown:   [34,  'PageDown',    'PageDown'],
  Space:      [32,  'Space',       ' '],
  Shift:      [16,  'ShiftLeft',   'Shift'],
  Control:    [17,  'ControlLeft', 'Control'],
  Alt:        [18,  'AltLeft',     'Alt'],
  Meta:       [91,  'MetaLeft',    'Meta'],
  F1:  [112, 'F1',  'F1'],
  F2:  [113, 'F2',  'F2'],
  F3:  [114, 'F3',  'F3'],
  F4:  [115, 'F4',  'F4'],
  F5:  [116, 'F5',  'F5'],
  F6:  [117, 'F6',  'F6'],
  F7:  [118, 'F7',  'F7'],
  F8:  [119, 'F8',  'F8'],
  F9:  [120, 'F9',  'F9'],
  F10: [121, 'F10', 'F10'],
  F11: [122, 'F11', 'F11'],
  F12: [123, 'F12', 'F12'],
  a: [65, 'KeyA', 'a'],
  b: [66, 'KeyB', 'b'],
  c: [67, 'KeyC', 'c'],
  v: [86, 'KeyV', 'v'],
  x: [88, 'KeyX', 'x'],
  z: [90, 'KeyZ', 'z'],
};

function resolveKey(key: string): [number, string, string] {
  if (key in KEY_DEFS) return KEY_DEFS[key];
  if (key.length === 1) {
    const code = /[a-zA-Z]/.test(key) ? `Key${key.toUpperCase()}`
      : /\d/.test(key) ? `Digit${key}`
      : '';
    return [key.toUpperCase().charCodeAt(0), code, key];
  }
  return [0, '', key];
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class CDPMouse {
  private _conn: CDPConnection;
  private _sessionId: string;
  private _x = 0;
  private _y = 0;

  constructor(connection: CDPConnection, sessionId: string) {
    this._conn = connection;
    this._sessionId = sessionId;
  }

  async move(x: number, y: number, options?: { steps?: number }): Promise<void> {
    const steps = options?.steps ?? 1;
    const startX = this._x;
    const startY = this._y;
    for (let i = 1; i <= steps; i++) {
      const ix = startX + (x - startX) * (i / steps);
      const iy = startY + (y - startY) * (i / steps);
      await this._conn.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: ix,
        y: iy,
      }, this._sessionId);
    }
    this._x = x;
    this._y = y;
  }

  async click(x: number, y: number, options?: { button?: string; clickCount?: number; delay?: number }): Promise<void> {
    const button = options?.button ?? 'left';
    const clickCount = options?.clickCount ?? 1;
    await this.move(x, y);
    await this._conn.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button,
      x: this._x,
      y: this._y,
      clickCount,
    }, this._sessionId);
    if (options?.delay && options.delay > 0) await delay(options.delay);
    await this._conn.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button,
      x: this._x,
      y: this._y,
      clickCount,
    }, this._sessionId);
  }

  async dblclick(x: number, y: number): Promise<void> {
    await this.click(x, y, { clickCount: 1 });
    await this.click(x, y, { clickCount: 2 });
  }
}

export class CDPKeyboard {
  private _conn: CDPConnection;
  private _sessionId: string;
  private _modifiers = 0;

  constructor(connection: CDPConnection, sessionId: string) {
    this._conn = connection;
    this._sessionId = sessionId;
  }

  async down(key: string): Promise<void> {
    const [keyCode, code, keyVal] = resolveKey(key);
    if (key === 'Shift') this._modifiers |= 8;
    else if (key === 'Control') this._modifiers |= 4;
    else if (key === 'Alt') this._modifiers |= 2;
    else if (key === 'Meta') this._modifiers |= 1;
    await this._conn.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: keyVal,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers: this._modifiers,
    }, this._sessionId);
  }

  async up(key: string): Promise<void> {
    const [keyCode, code, keyVal] = resolveKey(key);
    if (key === 'Shift') this._modifiers &= ~8;
    else if (key === 'Control') this._modifiers &= ~4;
    else if (key === 'Alt') this._modifiers &= ~2;
    else if (key === 'Meta') this._modifiers &= ~1;
    await this._conn.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: keyVal,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers: this._modifiers,
    }, this._sessionId);
  }

  async press(key: string, options?: { delay?: number }): Promise<void> {
    await this.down(key);
    if (options?.delay && options.delay > 0) await delay(options.delay);
    await this.up(key);
  }

  async type(text: string, options?: { delay?: number }): Promise<void> {
    const d = options?.delay ?? 0;
    for (const char of text) {
      if (char in KEY_DEFS) {
        await this.press(char, { delay: d });
      } else {
        await this._conn.send('Input.insertText', { text: char }, this._sessionId);
      }
      if (d > 0) await delay(d);
    }
  }
}
