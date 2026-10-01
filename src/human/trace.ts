// Recorded operator pointer geometry, loaded once per run.
// Pointer replay uses spatially perturbed geometry, not inter-step pauses.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { humanRandom } from '../utils/motion/timing.js';

interface TraceEvent { type: string; x?: number|null; y?: number|null; }

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

interface Waypoint { u: number; v: number; } // normalized coordinates
interface Segment { points: Waypoint[]; aspect: number; }

function derive() {
  const evts = loadLatestTrace();
  const segments: Segment[] = [];
  let segBuf: { x: number; y: number }[] = [];
  for (const e of evts) {
    if (e.type === 'pointermove' && e.x != null && e.y != null) {
      segBuf.push({ x: e.x, y: e.y });
    } else if (e.type === 'click') {
      // Finalize segment: normalize (dx,dy) against the end-to-start delta.
      if (segBuf.length >= 4) {
        const s = segBuf[0], end = segBuf[segBuf.length - 1];
        const rx = end.x - s.x, ry = end.y - s.y;
        const mag = Math.hypot(rx, ry);
        if (mag > 20) {
          const aspect = Math.abs(rx) > 0.1 ? Math.abs(ry / rx) : 999;
          const points: Waypoint[] = segBuf.map(p => ({ u: rx === 0 ? 0 : (p.x - s.x) / rx, v: ry === 0 ? 0 : (p.y - s.y) / ry }));
          segments.push({ points, aspect });
        }
      }
      segBuf = [];
    }
  }
  return { segments, sourceCount: evts.length };
}

const T = derive();
if (T.sourceCount > 0) {
  console.log(`[human/trace] loaded ${T.sourceCount} events: segments=${T.segments.length}`);
}

// Return a denormalized waypoint sequence for a move from (ax,ay) to (bx,by),
// using a real recorded pointer segment of matching aspect ratio. Output page
// coords with per-point ±3-8 px spatial jitter. If no segments are available,
// return an empty array — caller will fall back to the Bezier generator.
export function getMoveTemplate(ax: number, ay: number, bx: number, by: number): { x: number; y: number }[] {
  if (!T.segments.length) return [];
  const rx = bx - ax, ry = by - ay;
  const targetAspect = Math.abs(rx) > 0.1 ? Math.abs(ry / rx) : 999;
  // Pick segment with closest aspect within random top-3 for variety
  const sorted = T.segments.map(s => ({ s, d: Math.abs(s.aspect - targetAspect) })).sort((a, b) => a.d - b.d);
  const pool = sorted.slice(0, Math.min(5, sorted.length));
  const pick = pool[Math.floor(humanRandom() * pool.length)].s;
  return pick.points.map(p => ({
    x: Math.round(ax + p.u * rx + (humanRandom() * 2 - 1) * 6),
    y: Math.round(ay + p.v * ry + (humanRandom() * 2 - 1) * 6),
  }));
}
