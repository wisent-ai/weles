// Tile-classification consensus for reCAPTCHA v2 image grids. Extracted from
// recaptcha.ts to keep that file under the 300-line cap. Runs NopeCha,
// CapSolver, 2captcha, and Claude vision in parallel; prefers Claude when
// available, otherwise ≥2-of-N majority; falls back to disagreementTiebreaker
// on thin majorities. Element-screenshots the live grid container so cell
// replacement between rounds is reflected in the image sent to solvers.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CATEGORY_CODES: Record<string, string> = {
  taxi: '/m/0pg52', taxis: '/m/0pg52', bus: '/m/01bjv', buses: '/m/01bjv',
  'school bus': '/m/02yvhj', motorcycle: '/m/04_sv', motorcycles: '/m/04_sv',
  tractor: '/m/013xlm', tractors: '/m/013xlm', chimney: '/m/01jk_4', chimneys: '/m/01jk_4',
  crosswalk: '/m/014xcs', crosswalks: '/m/014xcs', 'traffic light': '/m/015qff', 'traffic lights': '/m/015qff',
  bicycle: '/m/0199g', bicycles: '/m/0199g', 'parking meter': '/m/015qbp', 'parking meters': '/m/015qbp',
  car: '/m/0k4j', cars: '/m/0k4j', bridge: '/m/015kr', bridges: '/m/015kr',
  boat: '/m/019jd', boats: '/m/019jd', 'palm tree': '/m/0cdl1', 'palm trees': '/m/0cdl1',
  mountain: '/m/09d_r', mountains: '/m/09d_r', 'mountains or hills': '/m/09d_r',
  'fire hydrant': '/m/01pns0', 'fire hydrants': '/m/01pns0',
  stair: '/m/01lynh', stairs: '/m/01lynh',
};

export function instructionToCode(instruction: string): string | null {
  const text = instruction.toLowerCase();
  const keys = Object.keys(CATEGORY_CODES).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const re = new RegExp(`\\b${k.replace(/\s+/g, '\\s+')}\\b`);
    if (re.test(text)) return CATEGORY_CODES[k];
  }
  return null;
}

export async function classifyGrid(bframe: any, instruction: string, gridSize: number): Promise<number[] | null> {
  let gridImgB64: string | null = null;
  try {
    const targetSel = 'div.rc-imageselect-payload, table.rc-imageselect-table-33, table.rc-imageselect-table-44, table.rc-imageselect-table';
    const handle = await bframe.$(targetSel);
    if (handle) {
      const shotP = handle.screenshot({ type: 'jpeg', quality: 90 });
      const deadline = new Promise<Buffer>((_, rej) => setTimeout(() => rej(new Error('screenshot_deadline')), 6000));
      const buf = await Promise.race([shotP, deadline]);
      gridImgB64 = buf.toString('base64');
    }
  } catch (e: any) { console.log(`[recaptcha] grid screenshot err: ${e?.message?.slice(0, 80)}`); }
  if (!gridImgB64) return null;
  const diagDir = join(process.cwd(), 'recordings', 'vision');
  mkdirSync(diagDir, { recursive: true });
  writeFileSync(join(diagDir, 'extracted_grid_latest.png'), Buffer.from(gridImgB64, 'base64'));
  const { getCaptchaCredentials: getCreds } = await import('../utils/credentials.js');
  const creds = await getCreds();
  const instr = instruction.replace(/\n/g, ' ').trim();

  async function nopechaSolve(): Promise<number[] | null> {
    const k = creds.nopecha; if (!k) return null;
    try {
      const post = await (await fetch('https://api.nopecha.com/v1/recognition/recaptcha', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${k}` },
        body: JSON.stringify({ type: 'recaptcha', task: instr, image_data: [gridImgB64], grid: `${gridSize}x${gridSize}` }),
      })).json() as any;
      const jobId = post?.data; if (!jobId) return null;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));  // allow-raw-playwright: polling
        const g = await (await fetch(`https://api.nopecha.com/v1/recognition/recaptcha?id=${jobId}`, { headers: { 'Authorization': `Basic ${k}` } })).json() as any;
        if (Array.isArray(g?.data)) return (g.data as boolean[]).map((v, i) => v ? i + 1 : 0).filter(Boolean);
        if (g?.error && g.error !== 14) return null;
      }
    } catch {}
    return null;
  }
  async function capsolverSolve(): Promise<number[] | null> {
    const k = creds.capsolver; const q = instructionToCode(instruction); if (!k || !q) return null;
    try {
      const d = await (await fetch('https://api.capsolver.com/createTask', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: k, task: { type: 'ReCaptchaV2Classification', image: gridImgB64, question: q } }) })).json() as any;
      return Array.isArray(d.solution?.objects) ? (d.solution.objects as number[]).map(i => i + 1) : null;
    } catch { return null; }
  }
  async function twocaptchaSolve(): Promise<number[] | null> {
    const k = creds.twocaptcha; if (!k) return null;
    const c = await (await fetch('https://api.2captcha.com/createTask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: k, task: { type: 'GridTask', body: gridImgB64, comment: instr, rows: gridSize, columns: gridSize } }),
    })).json() as any;
    if (!c.taskId) return null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 3000));  // allow-raw-playwright: polling
      const r = await (await fetch('https://api.2captcha.com/getTaskResult', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: k, taskId: c.taskId }),
      })).json() as any;
      if (r.status === 'ready') return r.solution?.click ?? null;
      if (r.errorId) return null;
    }
    return null;
  }
  async function claudeSolve(): Promise<number[] | null> {
    try {
      const v = await import('../vision/analyze.js') as any;
      const ask = v.askClaude as ((b: Buffer, q: string, t?: string) => string) | undefined;
      if (!ask) return null;
      const grid = gridSize === 3 ? '1 2 3 / 4 5 6 / 7 8 9' : '1-4/5-8/9-12/13-16';
      const b64 = gridImgB64 as string;
      const ans = ask(Buffer.from(b64, 'base64'), `reCAPTCHA grid (${grid}). Instruction: "${instr}". Return ONLY a JSON array of positions, e.g. [1,4,7].`, 'tier_image');
      const mm = (ans || '').match(/\[[\d,\s]*\]/);
      if (!mm) return null;
      const p = JSON.parse(mm[0]);
      return Array.isArray(p) ? p as number[] : null;
    } catch { return null; }
  }
  const settled = await Promise.allSettled([nopechaSolve(), capsolverSolve(), twocaptchaSolve(), claudeSolve()]);
  const labels = ['NopeCha', 'CapSolver', '2captcha', 'Claude'];
  const answers: { name: string; positions: number[] }[] = [];
  settled.forEach((s, i) => {
    const pos = s.status === 'fulfilled' && Array.isArray(s.value) ? s.value as number[] : null;
    console.log(`[recaptcha] ${labels[i]}: ${pos ? JSON.stringify(pos) : 'null'}`);
    if (pos) answers.push({ name: labels[i], positions: pos });
  });
  if (answers.length === 0) return null;
  if (answers.length === 1) {
    try {
      const v = await import('../vision/analyze.js') as any;
      const ask = v.askClaude as ((b: Buffer, q: string, t?: string) => string) | undefined;
      if (ask) {
        const grid = gridSize === 3 ? '1 2 3 / 4 5 6 / 7 8 9' : '1-4/5-8/9-12/13-16';
        const ans = ask(Buffer.from(gridImgB64, 'base64'), `reCAPTCHA grid (${grid}). Instruction: "${instr}". Return ONLY a JSON array of positions, e.g. [1,4,7].`, 'tier_image');
        const mm = (ans || '').match(/\[[\d,\s]*\]/);
        if (mm) { try { const cp = JSON.parse(mm[0]); if (Array.isArray(cp)) { console.log(`[recaptcha] Claude tiebreaker: ${JSON.stringify(cp)}`); answers.push({ name: 'Claude', positions: cp }); } } catch {} }
      }
    } catch {}
    if (answers.length === 1) { console.log(`[recaptcha] Only ${answers[0].name} responded`); return answers[0].positions; }
  }
  const claudeAns = answers.find(a => a.name === 'Claude');
  if (claudeAns && claudeAns.positions.length > 0) {
    console.log(`[recaptcha] Submitting Claude's answer: ${JSON.stringify(claudeAns.positions)} (API solvers: ${answers.filter(a => a.name !== 'Claude').map(a => `${a.name}=${JSON.stringify(a.positions)}`).join(', ')})`);
    return claudeAns.positions.slice().sort((a, b) => a - b);
  }
  const tally = new Map<number, number>();
  for (const a of answers) for (const p of new Set(a.positions)) {
    if (!tally.has(p)) tally.set(p, 1); else tally.set(p, (tally.get(p) as number) + 1);
  }
  const majority = [...tally.entries()].filter(([, c]) => c >= 2).map(([p]) => p).sort((a, b) => a - b);
  console.log(`[recaptcha] No Claude answer; consensus (≥2 of ${answers.length}): ${JSON.stringify(majority)}`);
  const minT = gridSize === 3 ? 1 : 2;
  if (majority.length < minT) { const { disagreementTiebreaker } = await import('./consensus.js'); const t = await disagreementTiebreaker(answers, gridImgB64, instr, gridSize, minT); if (t && t.length > 0) return t; }
  return majority.length > 0 ? majority : answers[0].positions;
}
