// ---------------------------------------------------------------------------
// Human-like keyboard input
// ---------------------------------------------------------------------------

import { randomBetween, waitMs } from '../utils/timing.js';

export interface KeyboardPage {
  send(method: string, params?: Record<string, any>): Promise<any>;
}

/**
 * Type `text` character-by-character with random inter-key delays that mimic
 * human typing cadence.
 *
 * Uses CDP `Input.dispatchKeyEvent` so it works on any page backed by a CDP
 * connection.
 */
export async function humanType(page: any, text: string): Promise<void> {
  for (const char of text) {
    if (typeof page.send === 'function') {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char, key: char, unmodifiedText: char });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', text: char, key: char, unmodifiedText: char });
    } else if (page.keyboard) {
      await page.keyboard.press(char === ' ' ? 'Space' : char);
    }
    const pause = Math.random() < 0.08 ? randomBetween(200, 450) : randomBetween(50, 180);
    await waitMs(pause);
  }
}
