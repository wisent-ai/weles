import { describe, it, expect } from 'vitest';
import { parseXY, parseElements, filterElements } from '../src/vision/escalation.js';

describe('parseXY', () => {
  it('parses valid JSON', () => {
    expect(parseXY('{"x": 100, "y": 200}')).toEqual({ x: 100, y: 200 });
  });
  it('extracts JSON from prose', () => {
    expect(parseXY('The button is at {"x": 50, "y": 75} on the page')).toEqual({ x: 50, y: 75 });
  });
  it('extracts bare numbers', () => {
    expect(parseXY('coordinates: 320, 480')).toEqual({ x: 320, y: 480 });
  });
  it('handles negative coords', () => {
    expect(parseXY('-10 -20')).toEqual({ x: -10, y: -20 });
  });
  it('returns null on garbage', () => {
    expect(parseXY('I cannot find it')).toBeNull();
  });
  it('returns null on empty', () => {
    expect(parseXY('')).toBeNull();
  });
  it('rounds float coords', () => {
    expect(parseXY('{"x": 100.7, "y": 200.3}')).toEqual({ x: 101, y: 200 });
  });
});

describe('parseElements', () => {
  it('parses valid array', () => {
    const r = parseElements('[{"label":"btn","x":1,"y":2}]');
    expect(r).toHaveLength(1);
    expect(r[0].label).toBe('btn');
  });
  it('extracts array from prose', () => {
    const r = parseElements('Here are the elements: [{"label":"a","x":0,"y":0}] end');
    expect(r).toHaveLength(1);
  });
  it('returns empty on no brackets', () => {
    expect(parseElements('no array here')).toEqual([]);
  });
  it('returns empty on invalid JSON', () => {
    expect(parseElements('[{broken')).toEqual([]);
  });
  it('returns empty on empty string', () => {
    expect(parseElements('')).toEqual([]);
  });
});

describe('filterElements', () => {
  const els = [
    { label: 'Submit button', x: 100, y: 200 },
    { label: 'Cancel link', x: 300, y: 200 },
    { label: 'Username input', x: 100, y: 100 },
  ];
  it('matches by keyword', () => {
    expect(filterElements(els, 'submit button')).toEqual({ x: 100, y: 200 });
  });
  it('is case insensitive', () => {
    expect(filterElements(els, 'CANCEL LINK')).toEqual({ x: 300, y: 200 });
  });
  it('returns null on no match', () => {
    expect(filterElements(els, 'zzzzz')).toBeNull();
  });
  it('returns null on empty list', () => {
    expect(filterElements([], 'anything')).toBeNull();
  });
  it('skips elements without coordinates', () => {
    expect(filterElements([{ label: 'Submit button' } as any], 'submit')).toBeNull();
  });
});
