// The recorded pointer travel and wheel steps a move or scroll replays,
// read once per run from the harvested trace (pointer/trace-file.ts). A move
// replays one recorded segment carried onto the requested start and end: the
// recorded path is turned and scaled as a whole so its start lands on the
// start and its end on the end, keeping the hand's own curve and its spacing.

import { humanIndex } from '../utils/motion/timing.js';
import {
  readPointerTrace,
  type Point,
  type PointerTrace,
  type Segment,
  type WheelStep,
} from './pointer/trace-file.js';

let loaded: PointerTrace | null = null;

/** The harvested trace, read on first use and kept for the run. */
function trace(): PointerTrace {
  if (loaded === null) {
    loaded = readPointerTrace();
    console.log(
      `[human/trace] ${loaded.segments.length} segments and ${loaded.wheel.length} wheel steps from ${loaded.sources.join(', ')}`,
    );
  }
  return loaded;
}

/** One of `items`, drawn from the run's seeded timing source. */
function drawn<T>(items: readonly T[]): T {
  const item = items[humanIndex(items.length)];
  if (item === undefined)
    throw new Error('the pointer trace holds nothing to draw from');
  return item;
}

function endsOf(segment: Segment): { first: Point; last: Point } {
  const [first] = segment.points;
  const last = segment.points.findLast(() => true);
  if (first === undefined || last === undefined)
    throw new Error('a pointer trace segment holds no points');
  return { first, last };
}

/**
 * The waypoints of a move from `from` to `to`: one recorded segment carried
 * onto them by the similarity (turn and scale) that maps the segment's start
 * and end onto `from` and `to`, written as complex multiplication.
 */
export function replayedPath(from: Point, to: Point): Point[] {
  const segment = drawn(trace().segments);
  const { first, last } = endsOf(segment);
  const rx = last.x - first.x;
  const ry = last.y - first.y;
  const tx = to.x - from.x;
  const ty = to.y - from.y;
  const norm = rx * rx + ry * ry;
  // (tx + i·ty) / (rx + i·ry): the turn and scale from recorded to wanted.
  const a = (tx * rx + ty * ry) / norm;
  const b = (ty * rx - tx * ry) / norm;
  return segment.points.map((p) => {
    const px = p.x - first.x;
    const py = p.y - first.y;
    return { x: from.x + a * px - b * py, y: from.y + b * px + a * py };
  });
}

/** Where a recorded hand starts when it travels to `to` and nobody knows where it is: one segment's own start, carried so the segment ends at `to`. */
export function recordedApproach(to: Point): Point {
  const { first, last } = endsOf(drawn(trace().segments));
  return { x: to.x - (last.x - first.x), y: to.y - (last.y - first.y) };
}

/** One recorded wheel step. */
export function recordedWheelStep(): WheelStep {
  return drawn(trace().wheel);
}
