// Tile-classification consensus for reCAPTCHA v2 image grids. Runs two
// specialist services and one authenticated Stado-routed vision model in
// parallel, prefers the independent model result when available, otherwise
// uses the tiles most answering voters chose and the disagreement tiebreaker
// when no tile has such a majority. Tiles are numbered from zero, left to
// right and top to bottom, the order the challenge table lists its cells in.
// A voter that fails is logged with its cause and leaves the others to vote.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../session/run-recordings.js';
import { getCaptchaCredentials } from '../../utils/credentials.js';
import { askJedenAboutImage } from '../../vision/analyze.js';
import {
  disagreementTiebreaker,
  parsedTiles,
  tileLabels,
} from './consensus.js';

// The challenge words CapSolver's ReCaptchaV2Classification takes as Google's
// object codes; an instruction naming none is not sent to CapSolver.
const CATEGORY_CODES: Record<string, string> = {
  taxi: '/m/0pg52',
  taxis: '/m/0pg52',
  bus: '/m/01bjv',
  buses: '/m/01bjv',
  'school bus': '/m/02yvhj',
  motorcycle: '/m/04_sv',
  motorcycles: '/m/04_sv',
  tractor: '/m/013xlm',
  tractors: '/m/013xlm',
  chimney: '/m/01jk_4',
  chimneys: '/m/01jk_4',
  crosswalk: '/m/014xcs',
  crosswalks: '/m/014xcs',
  'traffic light': '/m/015qff',
  'traffic lights': '/m/015qff',
  bicycle: '/m/0199g',
  bicycles: '/m/0199g',
  'parking meter': '/m/015qbp',
  'parking meters': '/m/015qbp',
  car: '/m/0k4j',
  cars: '/m/0k4j',
  bridge: '/m/015kr',
  bridges: '/m/015kr',
  boat: '/m/019jd',
  boats: '/m/019jd',
  'palm tree': '/m/0cdl1',
  'palm trees': '/m/0cdl1',
  mountain: '/m/09d_r',
  mountains: '/m/09d_r',
  'mountains or hills': '/m/09d_r',
  'fire hydrant': '/m/01pns0',
  'fire hydrants': '/m/01pns0',
  stair: '/m/01lynh',
  stairs: '/m/01lynh',
};

// The bframe elements that hold the challenge image, payload first.
const GRID_SELECTOR =
  'div.rc-imageselect-payload, table.rc-imageselect-table-33, table.rc-imageselect-table-44, table.rc-imageselect-table';

export function instructionToCode(instruction: string): string | null {
  const text = instruction.toLowerCase();
  const keys = Object.keys(CATEGORY_CODES).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const re = new RegExp(`\\b${k.replace(/\s+/g, '\\s+')}\\b`);
    if (re.test(text)) return CATEGORY_CODES[k];
  }
  return null;
}

function said(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The challenge image as base64, or why it could not be taken. */
async function gridImage(bframe: any): Promise<string> {
  const handle = await bframe.$(GRID_SELECTOR);
  if (!handle)
    throw new Error(
      `RECAPTCHA_GRID_UNSEEN: no element of ${GRID_SELECTOR} is in the challenge frame`,
    );
  return (await handle.screenshot()).toString('base64');
}

export async function classifyGrid(
  bframe: any,
  instruction: string,
  gridSize: number,
): Promise<number[] | null> {
  const image = await gridImage(bframe);
  const diagDir = runRecordingsDir('vision');
  mkdirSync(diagDir, { recursive: true });
  writeFileSync(
    join(diagDir, 'extracted_grid_latest.png'),
    Buffer.from(image, 'base64'),
  );
  const creds = await getCaptchaCredentials();
  const instr = instruction.replace(/\n/g, ' ').trim();

  // NopeCHA answers one flag per tile, in tile order. One read: NopeCHA has
  // no push or blocking answer, so a job it has not finished is named with
  // what it answered.
  async function nopechaSolve(): Promise<number[] | null> {
    const k = creds.nopecha;
    if (!k) return null;
    const post = (await (
      await fetch('https://api.nopecha.com/v1/recognition/recaptcha', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${k}`,
        },
        body: JSON.stringify({
          type: 'recaptcha',
          task: instr,
          image_data: [image],
          grid: `${gridSize}x${gridSize}`,
        }),
      })
    ).json()) as any;
    const jobId = post?.data;
    if (!jobId)
      throw new Error(`nopecha took no grid job: ${JSON.stringify(post)}`);
    const g = (await (
      await fetch(
        `https://api.nopecha.com/v1/recognition/recaptcha?id=${jobId}`,
        {
          headers: { Authorization: `Basic ${k}` },
        },
      )
    ).json()) as any;
    if (!Array.isArray(g?.data))
      throw new Error(
        `nopecha grid job ${jobId} answered no tiles: ${JSON.stringify(g)}`,
      );
    return (g.data as boolean[]).flatMap((chosen, tile) =>
      chosen ? [tile] : [],
    );
  }
  // CapSolver answers the chosen tiles' indices in its createTask answer.
  async function capsolverSolve(): Promise<number[] | null> {
    const k = creds.capsolver;
    const q = instructionToCode(instruction);
    if (!k || !q) return null;
    const d = (await (
      await fetch('https://api.capsolver.com/createTask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientKey: k,
          task: { type: 'ReCaptchaV2Classification', image, question: q },
        }),
      })
    ).json()) as any;
    if (!Array.isArray(d.solution?.objects))
      throw new Error(`capsolver classified no tiles: ${JSON.stringify(d)}`);
    return d.solution.objects as number[];
  }
  async function modelSolve(): Promise<number[] | null> {
    const answer = await askJedenAboutImage(
      Buffer.from(image, 'base64'),
      `reCAPTCHA grid, tiles labelled ${tileLabels(gridSize, ' / ')}. Instruction: "${instr}". Return ONLY a JSON array of the labels of the matching tiles.`,
      'tier_image',
    );
    return parsedTiles(answer);
  }
  const voters = [
    { name: 'NopeCha', solve: nopechaSolve },
    { name: 'CapSolver', solve: capsolverSolve },
    { name: 'Model', solve: modelSolve },
  ];
  const settled = await Promise.allSettled(
    voters.map((voter) => voter.solve()),
  );
  const answers: { name: string; positions: number[] }[] = [];
  settled.forEach((outcome, index) => {
    const { name } = voters[index];
    if (outcome.status === 'rejected') {
      console.log(`[recaptcha] ${name} failed: ${said(outcome.reason)}`);
      return;
    }
    console.log(
      `[recaptcha] ${name}: ${outcome.value ? JSON.stringify(outcome.value) : 'not asked'}`,
    );
    if (outcome.value) answers.push({ name, positions: outcome.value });
  });
  const [first, ...others] = answers;
  if (!first) return null;
  if (!others.length) {
    console.log(`[recaptcha] Only ${first.name} responded`);
    return first.positions;
  }
  const modelAnswer = answers.find((a) => a.name === 'Model');
  if (modelAnswer?.positions.length) {
    const rest = answers
      .filter((a) => a !== modelAnswer)
      .map((a) => `${a.name}=${JSON.stringify(a.positions)}`)
      .join(', ');
    console.log(
      `[recaptcha] Submitting model answer: ${JSON.stringify(modelAnswer.positions)} (other solvers: ${rest})`,
    );
    return modelAnswer.positions.slice().sort((a, b) => a - b);
  }
  // A tile is in the consensus when more of the answering voters chose it
  // than did not.
  const chosen = [...new Set(answers.flatMap((a) => a.positions))];
  const majority = chosen
    .filter((tile) => {
      const votes = answers.filter((a) => a.positions.includes(tile)).length;
      return votes > answers.length - votes;
    })
    .sort((a, b) => a - b);
  console.log(
    `[recaptcha] No model answer; majority of ${answers.length}: ${JSON.stringify(majority)}`,
  );
  if (majority.length) return majority;
  return disagreementTiebreaker(answers, image, instr, gridSize);
}
