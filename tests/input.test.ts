import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bezierPath, instantMode } from '../src/cdp/input.js';

describe('bezierPath', () => {
  it('starts at start point', () => {
    const path = bezierPath([0, 0], [100, 100]);
    expect(path[0][0]).toBe(0);
    expect(path[0][1]).toBe(0);
  });
  it('ends at end point', () => {
    const path = bezierPath([0, 0], [100, 100]);
    const last = path[path.length - 1];
    expect(last[0]).toBe(100);
    expect(last[1]).toBe(100);
  });
  it('scales steps with distance', () => {
    const short = bezierPath([0, 0], [10, 10]);
    const long = bezierPath([0, 0], [500, 500]);
    expect(short.length).toBeLessThan(long.length);
  });
  it('respects min 15 steps', () => {
    const path = bezierPath([0, 0], [1, 1]);
    expect(path.length).toBeGreaterThanOrEqual(16); // 15 steps + 1
  });
  it('respects max 60 steps', () => {
    const path = bezierPath([0, 0], [10000, 10000]);
    expect(path.length).toBeLessThanOrEqual(61); // 60 steps + 1
  });
  it('accepts explicit step count', () => {
    const path = bezierPath([0, 0], [100, 100], 5);
    expect(path.length).toBe(6); // 5 steps + 1
  });
});

describe('instantMode', () => {
  const orig = process.env.WELES_INSTANT_INPUT;
  afterEach(() => {
    if (orig === undefined) delete process.env.WELES_INSTANT_INPUT;
    else process.env.WELES_INSTANT_INPUT = orig;
  });
  it('returns false by default', () => {
    delete process.env.WELES_INSTANT_INPUT;
    expect(instantMode()).toBe(false);
  });
  it('returns true when set to 1', () => {
    process.env.WELES_INSTANT_INPUT = '1';
    expect(instantMode()).toBe(true);
  });
  it('returns false for other values', () => {
    process.env.WELES_INSTANT_INPUT = 'yes';
    expect(instantMode()).toBe(false);
  });
});
