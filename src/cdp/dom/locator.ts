/**
 * Element locator bound to a CDPFrame and CSS/XPath selector.
 *
 * Mirrors the Python CDPLocator API.  All DOM access goes through
 * frame.evaluate() so we never require Runtime.enable.
 */

import type { CDPFrame } from '../page/frame.js';

// ---------------------------------------------------------------------------
// Internal JS helpers
// ---------------------------------------------------------------------------

/**
 * Build a JS snippet that resolves the target element into a local `el`
 * variable, handling both CSS selectors and xpath= prefixed selectors.
 */
function resolveElementJS(selector: string, index: number): string {
  const isXPath = selector.startsWith('xpath=');
  if (isXPath) {
    const xpath = selector.slice('xpath='.length);
    const idx = index === -1 ? 0 : index;
    return `
      var __xr = document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      var el = __xr.snapshotItem(${idx});
    `;
  }
  return `
    var __els = document.querySelectorAll(${JSON.stringify(selector)});
    var el = ${index === -1 ? '__els[0]' : `__els[${index}]`};
  `;
}

// ---------------------------------------------------------------------------
// CDPLocator
// ---------------------------------------------------------------------------

export class CDPLocator {
  private _frame: CDPFrame;
  private _selector: string;
  private _index: number;

  constructor(frame: CDPFrame, selector: string, index: number = -1) {
    this._frame = frame;
    this._selector = selector;
    this._index = index;
  }

  // -- Narrowing -----------------------------------------------------------

  /** Return a locator targeting the first matching element. */
  get first(): CDPLocator {
    return new CDPLocator(this._frame, this._selector, 0);
  }

  /** Return a locator targeting the nth matching element (0-based). */
  nth(n: number): CDPLocator {
    return new CDPLocator(this._frame, this._selector, n);
  }

  // -- Actions -------------------------------------------------------------

  /**
   * Click the centre of the element.
   *
   * Evaluates to obtain the bounding box, then dispatches
   * Input.dispatchMouseEvent via the frame's underlying connection.
   */
  async click(): Promise<void> {
    const box = await this.boundingBox();
    if (!box) throw new Error(`Element not found: ${this._selector}`);

    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    // Access the frame's private connection/session for raw CDP calls.
    const conn = (this._frame as any)._conn as import('../connection.js').CDPConnection;
    const sessionId: string = (this._frame as any)._sessionId;

    await conn.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    }, sessionId);

    await conn.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    }, sessionId);
  }

  /** Focus the element, clear its value, and set a new one. */
  async fill(value: string): Promise<void> {
    const resolve = resolveElementJS(this._selector, this._index);
    await this._frame.evaluate(`(() => {
      ${resolve}
      if (!el) throw new Error('Element not found');
      el.focus();
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  }

  /** Focus the element and type each character via Input.dispatchKeyEvent. */
  async type(text: string): Promise<void> {
    await this._focus();

    const conn = (this._frame as any)._conn as import('../connection.js').CDPConnection;
    const sessionId: string = (this._frame as any)._sessionId;

    for (const char of text) {
      await conn.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        text: char,
        key: char,
        unmodifiedText: char,
      }, sessionId);

      await conn.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: char,
      }, sessionId);
    }
  }

  /** Return the element's innerText. */
  async innerText(): Promise<string | null> {
    const resolve = resolveElementJS(this._selector, this._index);
    return this._frame.evaluate(`(() => {
      ${resolve}
      return el ? el.innerText : null;
    })()`);
  }

  /** Return the element's innerHTML. */
  async innerHTML(): Promise<string | null> {
    const resolve = resolveElementJS(this._selector, this._index);
    return this._frame.evaluate(`(() => {
      ${resolve}
      return el ? el.innerHTML : null;
    })()`);
  }

  /** Return the value of the given attribute. */
  async getAttribute(name: string): Promise<string | null> {
    const resolve = resolveElementJS(this._selector, this._index);
    return this._frame.evaluate(`(() => {
      ${resolve}
      return el ? el.getAttribute(${JSON.stringify(name)}) : null;
    })()`);
  }

  /**
   * Return whether the element is visible.
   *
   * Uses offsetParent as the primary check (null means display:none or
   * not in the DOM), with a special case for fixed-position elements.
   */
  async isVisible(): Promise<boolean> {
    const resolve = resolveElementJS(this._selector, this._index);
    return this._frame.evaluate(`(() => {
      ${resolve}
      if (!el) return false;
      if (el.offsetParent === null && window.getComputedStyle(el).position !== 'fixed') return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })()`);
  }

  /** Return the element's bounding rectangle. */
  async boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const resolve = resolveElementJS(this._selector, this._index);
    return this._frame.evaluate(`(() => {
      ${resolve}
      if (!el) return null;
      var r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`);
  }

  // -- Private helpers -----------------------------------------------------

  private async _focus(): Promise<void> {
    const resolve = resolveElementJS(this._selector, this._index);
    await this._frame.evaluate(`(() => {
      ${resolve}
      if (el) el.focus();
    })()`);
  }
}
