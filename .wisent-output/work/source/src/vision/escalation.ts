/**
 * Vision query escalation helpers for find_click_target.
 *
 * Multi-tier pipeline that changes the input image and question format:
 *   tier_0_bare      — bare question on full screenshot
 *   tier_1_crop      — same question on centre crop (50% wide, 60% tall)
 *   tier_2_decompose — enumerate all UI controls as JSON, filter by description
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
  } catch { /* continue */ }

  // Try finding JSON object in text
  const jsonMatch = answer.match(/\{[\s\S]*?"x"\s*:\s*\d[\s\S]*?"y"\s*:\s*\d[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[0]);
      if (typeof data.x === 'number' && typeof data.y === 'number') {
        return { x: Math.round(data.x), y: Math.round(data.y) };
      }
    } catch { /* continue */ }
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
  } catch { /* skip */ }
  return [];
}

export function filterElements(
  elements: Array<Record<string, any>>,
  description: string,
): { x: number; y: number } | null {
  if (!elements.length) return null;
  const keywords = description.toLowerCase().split(/\W+/).filter(w => w.length > 2);
  let best: { x: number; y: number } | null = null;
  let bestScore = 0;
  for (const el of elements) {
    if (!el || typeof el !== 'object') continue;
    const label = String(el.label ?? '').toLowerCase();
    const score = keywords.reduce((s, k) => s + (label.includes(k) ? 1 : 0), 0);
    if (score > bestScore && typeof el.x === 'number' && typeof el.y === 'number') {
      best = { x: Math.round(el.x), y: Math.round(el.y) };
      bestScore = score;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Centre crop (uses sharp if available, otherwise skips)
// ---------------------------------------------------------------------------

export async function centerCrop(
  pngBytes: Buffer,
  fracW = 0.5,
  fracH = 0.6,
): Promise<{ cropped: Buffer | null; offsetX: number; offsetY: number }> {
  try {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(pngBytes).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (!w || !h) return { cropped: null, offsetX: 0, offsetY: 0 };
    const cw = Math.floor(w * fracW);
    const ch = Math.floor(h * fracH);
    const ox = Math.floor((w - cw) / 2);
    const oy = Math.floor((h - ch) / 2);
    const buf = await sharp(pngBytes)
      .extract({ left: ox, top: oy, width: cw, height: ch })
      .png()
      .toBuffer();
    return { cropped: buf, offsetX: ox, offsetY: oy };
  } catch {
    return { cropped: null, offsetX: 0, offsetY: 0 };
  }
}
