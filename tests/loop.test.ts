import { describe, it, expect } from 'vitest';
import { parseJsonFrom } from '../src/agent/loop.js';

describe('parseJsonFrom', () => {
  it('parses valid JSON directly', () => {
    const r = parseJsonFrom('{"tool":"click","args":{"target":"btn"}}');
    expect(r.tool).toBe('click');
    expect(r.args.target).toBe('btn');
  });
  it('extracts JSON from prose', () => {
    const r = parseJsonFrom('I will click the button. {"tool":"click","args":{}} Done.');
    expect(r.tool).toBe('click');
  });
  it('handles nested braces', () => {
    const r = parseJsonFrom('{"tool":"fill","args":{"value":"{hello}"}}');
    expect(r.tool).toBe('fill');
  });
  it('returns give_up on garbage', () => {
    const r = parseJsonFrom('this is not json at all');
    expect(r.tool).toBe('give_up');
  });
  it('returns give_up on empty', () => {
    const r = parseJsonFrom('');
    expect(r.tool).toBe('give_up');
  });
  it('prefers object with tool key', () => {
    const r = parseJsonFrom('{"x":1} then {"tool":"navigate","args":{"url":"http://a.com"}}');
    expect(r.tool).toBe('navigate');
  });
});
