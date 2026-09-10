/** Shared cubic Bezier curve math for mouse path generation. */

export function cubicBezier(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/**
 * Generate a path of points along a cubic Bezier curve from `start` to `end`.
 * Control points are randomized to create natural-looking movement.
 */
export function bezierPath(
  start: [number, number],
  end: [number, number],
  steps?: number,
): Array<[number, number]> {
  const [x0, y0] = start;
  const [x3, y3] = end;
  const dist = Math.hypot(x3 - x0, y3 - y0);
  const n = steps ?? Math.max(15, Math.min(60, Math.floor(dist / 8)));
  const cx1 = x0 + (x3 - x0) * (0.1 + Math.random() * 0.3) + (Math.random() * 60 - 30);
  const cy1 = y0 + (y3 - y0) * (0.1 + Math.random() * 0.3) + (Math.random() * 60 - 30);
  const cx2 = x0 + (x3 - x0) * (0.6 + Math.random() * 0.3) + (Math.random() * 60 - 30);
  const cy2 = y0 + (y3 - y0) * (0.6 + Math.random() * 0.3) + (Math.random() * 60 - 30);
  const points: Array<[number, number]> = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const x = u ** 3 * x0 + 3 * u ** 2 * t * cx1 + 3 * u * t ** 2 * cx2 + t ** 3 * x3;
    const y = u ** 3 * y0 + 3 * u ** 2 * t * cy1 + 3 * u * t ** 2 * cy2 + t ** 3 * y3;
    points.push([x, y]);
  }
  return points;
}
