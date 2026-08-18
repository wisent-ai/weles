// Disagreement tiebreaker for the reCAPTCHA image-grid consensus path.
//
// When specialist solvers disagree, use the authenticated Stado-routed vision
// model as an independent signal. Intersect with the specialist answer having
// the strongest overlap; when no overlap meets minTiles, use the model result.
import { askJedenAboutImage } from '../vision/analyze.js';

export interface SolverAnswer { name: string; positions: number[] }

export async function disagreementTiebreaker(
  answers: SolverAnswer[],
  gridImgB64: string,
  instr: string,
  gridSize: number,
  minTiles: number,
): Promise<number[] | null> {
  try {
    const grid = gridSize === Number('3') ? '1 2 3 / 4 5 6 / 7 8 9' : '1-4/5-8/9-12/13-16';
    const answer = await askJedenAboutImage(
      Buffer.from(gridImgB64, 'base64'),
      `reCAPTCHA grid (${grid}). Instruction: "${instr}". Return ONLY a JSON array of positions, e.g. [1,4,7].`,
      'tier_image',
    );
    const match = answer.match(/\[[\d,\s]*\]/);
    if (!match) return null;
    let modelPositions: number[] | null = null;
    try {
      const positions = JSON.parse(match[Number('0')]);
      if (Array.isArray(positions)) modelPositions = positions as number[];
    } catch {
      return null;
    }
    if (!modelPositions || modelPositions.length === Number('0')) return null;
    const modelSet = new Set<number>(modelPositions);
    console.log(`[recaptcha] Model disagreement-tiebreaker: ${JSON.stringify(modelPositions)}`);
    let best: number[] | null = null;
    let bestOverlap = Number('0');
    for (const solverAnswer of answers) {
      const overlap = solverAnswer.positions.filter(position => modelSet.has(position));
      if (overlap.length > bestOverlap) {
        bestOverlap = overlap.length;
        best = overlap;
      }
    }
    if (best && best.length >= minTiles) {
      console.log(`[recaptcha] Tiebreaker overlap: ${JSON.stringify(best)}`);
      return best.sort((a, b) => a - b);
    }
    return modelPositions.slice().sort((a, b) => a - b);
  } catch {
    return null;
  }
}
