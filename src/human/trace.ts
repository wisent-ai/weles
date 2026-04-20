// Operator behavior trace replay with per-run perturbation.
// Loads recordings/behavior_*.jsonl (captured via capture_fingerprint_local.mjs
// PROBE_WAIT mode) once at module init. Extracts ordered timing sequences so
// humanType/humanClick/humanMove can advance through them in order, preserving
// the shape of real operator behavior instead of sampling from distribution
// bins. Each read jitters ±20-40% so two runs never emit byte-identical traces.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

interface TraceEvent { t: number; type: string; x?: number|null; y?: number|null; code?: string|null; }

function loadLatestTrace(): TraceEvent[] {
  const dir = join(process.cwd(), 'recordings');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(f => f.startsWith('behavior_') && f.endsWith('.jsonl')).sort();
  if (!files.length) return [];
  const path = join(dir, files[files.length - 1]);
  const raw = readFileSync(path, 'utf8');
  const out: TraceEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

interface Waypoint { u: number; v: number; dt: number; } // u,v in [0,1]; dt ms from segment start
interface Segment { points: Waypoint[]; aspect: number; }

function derive() {
  const evts = loadLatestTrace();
  const interKey: number[] = [], dwell: number[] = [], stepMs: number[] = [], reaction: number[] = [], interClick: number[] = [];
  const segments: Segment[] = [];
  const lastDown: Record<string, number> = {};
  let lastKeyDownT = -1;
  let lastPointerT = -1;
  let lastPointerDownT = -1;
  let lastClickT = -1;
  let segBuf: { x: number; y: number; t: number }[] = [];
  for (const e of evts) {
    if (e.type === 'keydown' && e.code) {
      lastDown[e.code] = e.t;
      if (lastKeyDownT > 0) { const d = e.t - lastKeyDownT; if (d > 0 && d < 5000) interKey.push(d); }
      lastKeyDownT = e.t;
    } else if (e.type === 'keyup' && e.code && lastDown[e.code]) {
      const d = e.t - lastDown[e.code]; if (d > 0 && d < 1000) dwell.push(d);
    } else if (e.type === 'pointermove' && e.x != null && e.y != null) {
      if (lastPointerT > 0) { const d = e.t - lastPointerT; if (d > 0 && d < 500) stepMs.push(d); }
      lastPointerT = e.t;
      segBuf.push({ x: e.x, y: e.y, t: e.t });
    } else if (e.type === 'pointerdown') { lastPointerDownT = e.t; }
    else if (e.type === 'click') {
      if (lastPointerDownT > 0) { const d = e.t - lastPointerDownT; if (d > 0 && d < 2000) reaction.push(d); lastPointerDownT = -1; }
      if (lastClickT > 0) { const g = e.t - lastClickT; if (g > 50 && g < 30000) interClick.push(g); }
      lastClickT = e.t;
      // Finalize segment: normalize (dx,dy) against end-to-start delta, dt against start
      if (segBuf.length >= 4) {
        const s = segBuf[0], end = segBuf[segBuf.length - 1];
        const rx = end.x - s.x, ry = end.y - s.y;
        const mag = Math.hypot(rx, ry);
        if (mag > 20) {
          const aspect = Math.abs(rx) > 0.1 ? Math.abs(ry / rx) : 999;
          const points: Waypoint[] = segBuf.map(p => ({ u: rx === 0 ? 0 : (p.x - s.x) / rx, v: ry === 0 ? 0 : (p.y - s.y) / ry, dt: p.t - s.t }));
          segments.push({ points, aspect });
        }
      }
      segBuf = [];
    }
  }
  return { interKey, dwell, stepMs, reaction, interClick, segments, sourceCount: evts.length };
}

const T = derive();
if (T.sourceCount > 0) {
  console.log(`[human/trace] loaded ${T.sourceCount} events: interKey=${T.interKey.length} dwell=${T.dwell.length} stepMs=${T.stepMs.length} reaction=${T.reaction.length} interClick=${T.interClick.length} segments=${T.segments.length}`);
}

function jitter(v: number, frac: number): number {
  const f = 1 + (Math.random() * 2 - 1) * frac;
  return Math.max(1, Math.round(v * f));
}

const cursors = { interKey: 0, dwell: 0, stepMs: 0, reaction: 0, interClick: 0 };
function nextFrom(arr: number[], key: keyof typeof cursors, frac: number, defaultMs: number): number {
  if (!arr.length) return defaultMs;
  const v = arr[cursors[key] % arr.length];
  cursors[key]++;
  return jitter(v, frac);
}

export function traceAvailable(): boolean { return T.interKey.length > 0; }
export function nextInterKeyMs(): number { return nextFrom(T.interKey, 'interKey', 0.30, 170); }
export function nextDwellMs(): number { return nextFrom(T.dwell, 'dwell', 0.25, 105); }
export function nextPointerStepMs(): number { return nextFrom(T.stepMs, 'stepMs', 0.35, 15); }
export function nextReactionMs(): number { return nextFrom(T.reaction, 'reaction', 0.25, 200); }
export function nextInterClickMs(): number { return nextFrom(T.interClick, 'interClick', 0.25, 3000); }

// Return a denormalized waypoint sequence for a move from (ax,ay) to (bx,by),
// using a real recorded pointer segment of matching aspect ratio. Output page
// coords with per-point ±3-8 px spatial jitter. If no segments are available,
// return an empty array — caller will fall back to the Bezier generator.
export function getMoveTemplate(ax: number, ay: number, bx: number, by: number): { x: number; y: number; dt: number }[] {
  if (!T.segments.length) return [];
  const rx = bx - ax, ry = by - ay;
  const targetAspect = Math.abs(rx) > 0.1 ? Math.abs(ry / rx) : 999;
  // Pick segment with closest aspect within random top-3 for variety
  const sorted = T.segments.map(s => ({ s, d: Math.abs(s.aspect - targetAspect) })).sort((a, b) => a.d - b.d);
  const pool = sorted.slice(0, Math.min(5, sorted.length));
  const pick = pool[Math.floor(Math.random() * pool.length)].s;
  return pick.points.map(p => ({
    x: Math.round(ax + p.u * rx + (Math.random() * 2 - 1) * 6),
    y: Math.round(ay + p.v * ry + (Math.random() * 2 - 1) * 6),
    dt: jitter(Math.max(1, Math.round(p.dt)), 0.25),
  }));
}
