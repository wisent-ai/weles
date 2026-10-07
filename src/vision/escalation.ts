/**
 * Vision query escalation helpers for find_click_target.
 *
 *   tier_0_bare      — bare question on the full screenshot
 *   tier_1_decompose — enumerate all UI controls as JSON, filter by description
 */

// ---------------------------------------------------------------------------
// Coordinate parsing
// ---------------------------------------------------------------------------

export function parseXY(answer: string): { x: number; y: number } | null {
  // Try direct JSON parse
  try {
    const data = JSON.parse(answer.trim());
    if (data && typeof data.x === 'number' && typeof data.y === 'number') {
      return { x: Math.round(data.x), y: Math.round(data.y) };
    }
  } catch {
    /* continue */
  }

  // Try finding JSON object in text
  const jsonMatch = answer.match(
    /\{[\s\S]*?"x"\s*:\s*\d[\s\S]*?"y"\s*:\s*\d[\s\S]*?\}/,
  );
  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[0]);
      if (typeof data.x === 'number' && typeof data.y === 'number') {
        return { x: Math.round(data.x), y: Math.round(data.y) };
      }
    } catch {
      /* continue */
    }
  }

  // Extract first two numbers as last resort
  const nums = answer.match(/-?\d+/g);
  if (nums && nums.length >= 2) {
    return { x: parseInt(nums[0], 10), y: parseInt(nums[1], 10) };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Element list parsing
// ---------------------------------------------------------------------------

export function parseElements(answer: string): Array<Record<string, any>> {
  try {
    const start = answer.indexOf('[');
    const end = answer.lastIndexOf(']');
    if (start >= 0 && end > start) {
      const data = JSON.parse(answer.slice(start, end + 1));
      if (Array.isArray(data)) return data;
    }
  } catch {
    /* skip */
  }
  return [];
}

export function filterElements(
  elements: Array<Record<string, any>>,
  description: string,
): { x: number; y: number } | null {
  if (!elements.length) return null;
  const keywords = description
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);
  let best: { x: number; y: number } | null = null;
  let bestScore = 0;
  for (const el of elements) {
    if (!el || typeof el !== 'object') continue;
    const label = String(el.label ?? '').toLowerCase();
    const score = keywords.reduce((s, k) => s + (label.includes(k) ? 1 : 0), 0);
    if (
      score > bestScore &&
      typeof el.x === 'number' &&
      typeof el.y === 'number'
    ) {
      best = { x: Math.round(el.x), y: Math.round(el.y) };
      bestScore = score;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Image size
// ---------------------------------------------------------------------------

// The PNG signature, then the IHDR chunk's length and type, then its width and
// height as big-endian 32-bit integers (PNG specification, section 11.2.2).
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const IHDR_WIDTH_OFFSET = PNG_SIGNATURE.length + 8;
const IHDR_HEIGHT_OFFSET = IHDR_WIDTH_OFFSET + 4;

/** Width and height of a PNG, read from its IHDR header. */
export function pngSize(png: Buffer): { width: number; height: number } {
  if (
    png.length < IHDR_HEIGHT_OFFSET + 4 ||
    !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    throw new Error(`screenshot is not a PNG (${png.length} bytes)`);
  }
  return {
    width: png.readUInt32BE(IHDR_WIDTH_OFFSET),
    height: png.readUInt32BE(IHDR_HEIGHT_OFFSET),
  };
}
