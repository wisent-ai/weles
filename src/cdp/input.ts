import { CDPConnection } from './connection.js';

function _instantMode(): boolean {
  return process.env.WELES_INSTANT_INPUT === '1';
}

function _bezierPath(
  start: [number, number],
  end: [number, number],
  steps?: number,
): Array<[number, number]> {
  const [x0, y0] = start;
  const [x3, y3] = end;
  const dist = Math.hypot(x3 - x0, y3 - y0);
  const n = steps ?? Math.max(15, Math.min(60, Math.floor(dist / 8)));
  const cx1 = x0 + (x3 - x0) * (0.1 + Math.random() * 0.3) + (Math.random() * 60 - 30);
  const cy1 = y0 + (y3 - y0) * (0.1 + Math.random() * 0.3) + (Math.random() * 60 - 30);
  const cx2 = x0 + (x3 - x0) * (0.6 + Math.random() * 0.3) + (Math.random() * 60 - 30);
  const cy2 = y0 + (y3 - y0) * (0.6 + Math.random() * 0.3) + (Math.random() * 60 - 30);
  const points: Array<[number, number]> = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const x = u ** 3 * x0 + 3 * u ** 2 * t * cx1 + 3 * u * t ** 2 * cx2 + t ** 3 * x3;
    const y = u ** 3 * y0 + 3 * u ** 2 * t * cy1 + 3 * u * t ** 2 * cy2 + t ** 3 * y3;
    points.push([x, y]);
  }
  return points;
}

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

  async move(x: number, y: number, options?: { steps?: number; instant?: boolean }): Promise<void> {
    const instant = options?.instant ?? _instantMode();
    if (instant) {
      await this._conn.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x, y,
      }, this._sessionId);
      this._x = x;
      this._y = y;
      return;
    }
    const path = _bezierPath([this._x, this._y], [x, y], options?.steps);
    for (const [ix, iy] of path) {
      await this._conn.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: ix, y: iy,
      }, this._sessionId);
      await delay(5 + Math.random() * 10);
    }
    this._x = x;
    this._y = y;
  }

  async click(x: number, y: number, options?: { button?: string; clickCount?: number; delay?: number; instant?: boolean }): Promise<void> {
    const button = options?.button ?? 'left';
    const clickCount = options?.clickCount ?? 1;
    const instant = options?.instant ?? _instantMode();
    // Jitter for human-like targeting
    const jx = x + (Math.random() * 3 - 1.5);
    const jy = y + (Math.random() * 3 - 1.5);
    await this.move(jx, jy, { instant });
    // Hover delay before pressing
    if (!instant) await delay(100 + Math.random() * 200);
    await this.down({ button, clickCount });
    const pressDelay = options?.delay != null
      ? options.delay
      : (instant ? 0 : 50 + Math.random() * 100);
    if (pressDelay > 0) await delay(pressDelay);
    await this.up({ button, clickCount });
  }

  async down(options?: { button?: string; clickCount?: number }): Promise<void> {
    await this._conn.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: options?.button ?? 'left',
      x: this._x,
      y: this._y,
      clickCount: options?.clickCount ?? 1,
    }, this._sessionId);
  }

  async up(options?: { button?: string; clickCount?: number }): Promise<void> {
    await this._conn.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: options?.button ?? 'left',
      x: this._x,
      y: this._y,
      clickCount: options?.clickCount ?? 1,
    }, this._sessionId);
  }

  async wheel(deltaX = 0, deltaY = 0): Promise<void> {
    await this._conn.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: this._x,
      y: this._y,
      deltaX,
      deltaY,
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

  async press(key: string, options?: { delay?: number; instant?: boolean }): Promise<void> {
    const instant = options?.instant ?? _instantMode();
    await this.down(key);
    const hold = options?.delay != null
      ? options.delay
      : (instant ? 0 : 40 + Math.random() * 80);
    if (hold > 0) await delay(hold);
    await this.up(key);
  }

  async type(text: string, options?: { delay?: number; instant?: boolean }): Promise<void> {
    const instant = options?.instant ?? _instantMode();
    for (const char of text) {
      if (char in KEY_DEFS) {
        await this.press(char, { instant });
      } else {
        await this.insertText(char);
      }
      if (instant) continue;
      let gap: number;
      if (options?.delay != null) {
        gap = options.delay;
      } else {
        gap = 80 + Math.random() * 100; // 80-180ms baseline
        if ('.;,!? '.includes(char)) gap += 50 + Math.random() * 150;
        if (Math.random() < 0.04) gap += 200 + Math.random() * 400; // thinking pause
      }
      if (gap > 0) await delay(gap);
    }
  }

  async insertText(text: string): Promise<void> {
    await this._conn.send('Input.insertText', { text }, this._sessionId);
  }
}
