// Disagreement tiebreaker for the reCAPTCHA image-grid consensus path.
//
// recaptcha.ts:classifyGrid asks 3 API solvers and computes a majority
// intersection. When two solvers respond but disagree (intersection empty
// or sub-threshold), the prior behavior submitted answers[0] — wrong about
// half the time on modern LinkedIn challenges. LinkedIn marks cookies stale
// on first wrong submit. Cite 2026-05-08T06:25 run: NopeCha=[6,9,10,15,16]
// vs 2captcha=[6,8,10,12,15,16] intersected to [6,10,15,16] (rejected); on
// attempt 3 NopeCha=[] vs 2captcha=[10,11] gave [] and clicked 0 tiles.
//
// Strategy: ask Claude vision via the local CLI, intersect with the API
// solver that overlaps Claude best. If no overlap meets minTiles, return
// Claude alone. Same Claude shell-out shape as the answers.length === 1
// path that already lives in recaptcha.ts.

export interface SolverAnswer { name: string; positions: number[] }

export async function disagreementTiebreaker(
  answers: SolverAnswer[],
  gridImgB64: string,
  instr: string,
  gridSize: number,
  minTiles: number,
): Promise<number[] | null> {
  try {
    const v = await import('../vision/analyze.js') as any;
    const ask = v.askClaude as ((b: Buffer, q: string, t?: string) => string) | undefined;
    if (!ask) return null;
    const grid = gridSize === 3 ? '1 2 3 / 4 5 6 / 7 8 9' : '1-4/5-8/9-12/13-16';
    const ans = ask(Buffer.from(gridImgB64, 'base64'), `reCAPTCHA grid (${grid}). Instruction: "${instr}". Return ONLY a JSON array of positions, e.g. [1,4,7].`, 'tier_image');
    const mm = (ans || '').match(/\[[\d,\s]*\]/);
    if (!mm) return null;
    let claudePos: number[] | null = null;
    try { const p = JSON.parse(mm[0]); if (Array.isArray(p)) claudePos = p as number[]; } catch { return null; }
    if (!claudePos || claudePos.length === 0) return null;
    const claudeSet = new Set<number>(claudePos);
    console.log(`[recaptcha] Claude disagreement-tiebreaker: ${JSON.stringify(claudePos)}`);
    let best: number[] | null = null;
    let bestOverlap = 0;
    for (const a of answers) {
      const overlap = a.positions.filter(p => claudeSet.has(p));
      if (overlap.length > bestOverlap) { bestOverlap = overlap.length; best = overlap; }
    }
    if (best && best.length >= minTiles) { console.log(`[recaptcha] Tiebreaker overlap: ${JSON.stringify(best)}`); return best.sort((a, b) => a - b); }
    return claudePos.slice().sort((a, b) => a - b);
  } catch { return null; }
}
