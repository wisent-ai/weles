// Pointer segments and wheel steps out of instrumentation dumps of runs a
// person drove. The page's input recorder (diagnostics/page/input_recorder.js)
// logs every pointermove, press and wheel event through the access log, and
// each dump keeps that log per frame under `accesses`. A segment is the
// travel between two presses: where the hand went to act. The caller names
// the dumps of operator-driven runs; a Weles automated run's moves are its
// own replay and would only repeat it.
import { readFileSync } from 'node:fs';
import type { Point, PointerTrace, Segment, WheelStep } from './trace-file.js';

/** The access-log object the input recorder writes under. */
const INPUT = 'Input';
/** The events that end a stretch of travel: the hand acted. */
const PRESSES: Readonly<Record<string, true>> = Object.freeze({
  pointerdown: true,
  click: true,
});

type LogEntry = { t: number; o: string; p: string; vs: string };
type FrameLog = { url: string; log: LogEntry[] };

/** The access logs one dump keeps; a dump whose collector never ran is refused. */
function frameLogs(path: string): FrameLog[] {
  const dump = JSON.parse(readFileSync(path, 'utf8')) as { accesses?: unknown };
  if (!Array.isArray(dump.accesses))
    throw new Error(
      `${path} holds no access log (accesses is ${JSON.stringify(dump.accesses)}): the run recorded no page input`,
    );
  return dump.accesses as FrameLog[];
}

/** Whether a stretch of travel went anywhere: its end is not its start. */
function travelled(points: Point[]): boolean {
  const [first] = points;
  const last = points.findLast(() => true);
  return (
    first !== undefined &&
    last !== undefined &&
    Boolean(Math.hypot(last.x - first.x, last.y - first.y))
  );
}

/** The segments and wheel steps one frame's log holds, in the order they happened. */
function harvestFrame(frame: FrameLog): {
  segments: Segment[];
  wheel: WheelStep[];
} {
  const segments: Segment[] = [];
  const wheel: WheelStep[] = [];
  let travel: Point[] = [];
  const events = frame.log
    .filter((entry) => entry.o === INPUT)
    .sort((a, b) => a.t - b.t);
  for (const entry of events) {
    const fields = JSON.parse(entry.vs) as Record<string, number>;
    if (entry.p === 'pointermove') {
      travel.push({ x: fields.x, y: fields.y });
    } else if (Object.hasOwn(PRESSES, entry.p)) {
      if (travelled(travel)) segments.push({ points: travel });
      travel = [];
    } else if (entry.p === 'wheel' && fields.dy) {
      wheel.push({ dx: fields.dx, dy: fields.dy });
    }
  }
  return { segments, wheel };
}

/** The pointer trace the named dumps hold; dumps that hold no travel at all are refused. */
export function harvestPointerTrace(sources: string[]): PointerTrace {
  const harvested = sources.flatMap(frameLogs).map(harvestFrame);
  const segments = harvested.flatMap((frame) => frame.segments);
  const wheel = harvested.flatMap((frame) => frame.wheel);
  if (!segments.length)
    throw new Error(
      `${sources.join(', ')} hold no pointer travel between two presses: name dumps of runs a person drove`,
    );
  if (!wheel.length)
    throw new Error(
      `${sources.join(', ')} hold no vertical wheel step: name a run in which the person scrolled`,
    );
  return { sources, segments, wheel };
}
