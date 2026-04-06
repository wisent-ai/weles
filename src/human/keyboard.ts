// ---------------------------------------------------------------------------
// Human-like keyboard input
// ---------------------------------------------------------------------------

export interface KeyboardPage {
  send(method: string, params?: Record<string, any>): Promise<any>;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Type `text` character-by-character with random inter-key delays that mimic
 * human typing cadence.
 *
 * Uses CDP `Input.dispatchKeyEvent` so it works on any page backed by a CDP
 * connection.
 */
export async function humanType(page: KeyboardPage, text: string): Promise<void> {
  for (const char of text) {
    // keyDown
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      text: char,
      key: char,
      unmodifiedText: char,
    });

    // keyUp
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      text: char,
      key: char,
      unmodifiedText: char,
    });

    // Human-like inter-key timing (50-200 ms baseline with occasional pauses)
    const pause = Math.random() < 0.08
      ? randomBetween(200, 450)  // occasional longer pause (thinking / hesitation)
      : randomBetween(50, 180);
    await waitMs(pause);
  }
}
