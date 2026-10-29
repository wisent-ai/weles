// Disagreement tiebreaker for the reCAPTCHA image-grid consensus path, and
// the tile labels every vision prompt of the grid shows.
//
// When specialist solvers disagree, use the authenticated Stado-routed vision
// model as an independent signal. Intersect with the specialist answer having
// the strongest overlap; when no answer overlaps it, use the model result.
// Tiles are numbered from zero, left to right and top to bottom.
import { askJedenAboutImage } from '../../vision/analyze.js';

export interface SolverAnswer {
  name: string;
  positions: number[];
}

/** The tile numbers of a `gridSize` by `gridSize` grid, row by row, rows
 * joined by `rowSeparator`. */
export function tileLabels(gridSize: number, rowSeparator: string): string {
  const rows = Array.from({ length: gridSize }, (_, row) =>
    Array.from({ length: gridSize }, (_, column) => row * gridSize + column).join(' '),
  );
  return rows.join(rowSeparator);
}

/** The tile numbers a vision answer lists as a JSON array; an answer holding
 * none is refused with what it said. */
export function parsedTiles(answer: string): number[] {
  const found = answer.match(/\[[\d,\s]*\]/);
  if (!found) throw new Error(`the vision model named no tiles: ${JSON.stringify(answer)}`);
  const [listed] = found;
  const tiles: unknown = JSON.parse(listed);
  if (!Array.isArray(tiles) || !tiles.every(Number.isInteger))
    throw new Error(`the vision model's tiles are not whole numbers: ${listed}`);
  return tiles as number[];
}

export async function disagreementTiebreaker(
  answers: SolverAnswer[],
  gridImgB64: string,
  instr: string,
  gridSize: number,
): Promise<number[]> {
  const answer = await askJedenAboutImage(
    Buffer.from(gridImgB64, 'base64'),
    `reCAPTCHA grid, tiles labelled ${tileLabels(gridSize, ' / ')}. Instruction: "${instr}". Return ONLY a JSON array of the labels of the matching tiles.`,
    'tier_image',
  );
  const modelPositions = parsedTiles(answer);
  const modelSet = new Set<number>(modelPositions);
  console.log(`[recaptcha] Model disagreement-tiebreaker: ${JSON.stringify(modelPositions)}`);
  let best: number[] = [];
  for (const solverAnswer of answers) {
    const overlap = solverAnswer.positions.filter((position) => modelSet.has(position));
    if (overlap.length > best.length) best = overlap;
  }
  if (best.length) {
    console.log(`[recaptcha] Tiebreaker overlap: ${JSON.stringify(best)}`);
    return best.slice().sort((a, b) => a - b);
  }
  return modelPositions.slice().sort((a, b) => a - b);
}
