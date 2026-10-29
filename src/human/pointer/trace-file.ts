// The pointer trace Weles moves by: segments of a person's pointer travel
// between two presses, and the wheel steps they scrolled with, harvested from
// operator-driven runs by `weles pointer harvest`. It lives beside the runs
// it came from, under WELES_RECORDINGS_ROOT. Nothing else supplies pointer
// geometry: a host without a harvested trace moves no pointer.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordingsBase } from '../../session/run-recordings.js';

export type Point = { readonly x: number; readonly y: number };
export type WheelStep = { readonly dx: number; readonly dy: number };

/** One stretch of travel, in the recorded page's own CSS pixels. */
export type Segment = { readonly points: readonly Point[] };

export type PointerTrace = {
  /** The instrumentation dumps the trace was harvested from. */
  readonly sources: readonly string[];
  readonly segments: readonly Segment[];
  readonly wheel: readonly WheelStep[];
};

export const TRACE_FILE = 'pointer-trace.json';

export function pointerTracePath(): string {
  return join(recordingsBase(), TRACE_FILE);
}

function isPoint(value: unknown): value is Point {
  const point = value as Point;
  return (
    typeof value === 'object' &&
    value !== null &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y)
  );
}

function isWheelStep(value: unknown): value is WheelStep {
  const step = value as WheelStep;
  return (
    typeof value === 'object' &&
    value !== null &&
    Number.isFinite(step.dx) &&
    Number.isFinite(step.dy)
  );
}

/**
 * The harvested trace. One that is absent, unreadable or not the shape
 * `weles pointer harvest` writes is refused naming the file and what to run.
 */
export function readPointerTrace(): PointerTrace {
  const path = pointerTracePath();
  if (!existsSync(path))
    throw new Error(
      `no pointer trace at ${path}: harvest one from operator-driven runs with weles pointer harvest --from <run>.inst.json`,
    );
  const document = JSON.parse(
    readFileSync(path, 'utf8'),
  ) as Partial<PointerTrace>;
  const { sources, segments, wheel } = document;
  if (
    !Array.isArray(sources) ||
    !Array.isArray(segments) ||
    !Array.isArray(wheel) ||
    !segments.every(
      (s) => Array.isArray(s?.points) && s.points.every(isPoint),
    ) ||
    !wheel.every(isWheelStep)
  )
    throw new Error(
      `${path} is not a pointer trace (sources, segments of points, wheel steps); harvest it again with weles pointer harvest`,
    );
  return { sources, segments, wheel };
}

export function writePointerTrace(trace: PointerTrace): string {
  const path = pointerTracePath();
  writeFileSync(path, `${JSON.stringify(trace, null, '\t')}\n`);
  return path;
}
