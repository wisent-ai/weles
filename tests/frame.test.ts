import { describe, it, expect } from 'vitest';
import { wrapExpression, extractValue } from '../src/cdp/page/frame.js';

describe('wrapExpression', () => {
  it('wraps arrow function', () => {
    expect(wrapExpression('() => 42')).toBe('(() => 42)()');
  });
  it('wraps async arrow', () => {
    expect(wrapExpression('async () => 1')).toBe('(async () => 1)()');
  });
  it('wraps function declaration', () => {
    expect(wrapExpression('function f() { return 1; }')).toBe('(function f() { return 1; })()');
  });
  it('passes arg to callable', () => {
    expect(wrapExpression('(x) => x', 'hello')).toBe('((x) => x)("hello")');
  });
  it('passes object arg', () => {
    const r = wrapExpression('(o) => o.x', { x: 1 });
    expect(r).toBe('((o) => o.x)({"x":1})');
  });
  it('leaves plain expression unchanged', () => {
    expect(wrapExpression('document.title')).toBe('document.title');
  });
  it('leaves numeric expression unchanged', () => {
    expect(wrapExpression('1 + 2')).toBe('1 + 2');
  });
});

describe('extractValue', () => {
  it('extracts value', () => {
    expect(extractValue({ result: { value: 42 } })).toBe(42);
  });
  it('extracts null value', () => {
    expect(extractValue({ result: { value: null } })).toBeNull();
  });
  it('extracts string', () => {
    expect(extractValue({ result: { value: 'hello' } })).toBe('hello');
  });
  it('throws on error subtype', () => {
    expect(() => extractValue({ result: { subtype: 'error', description: 'boom' } }))
      .toThrow('boom');
  });
  it('throws on exception details', () => {
    expect(() => extractValue({ exceptionDetails: { text: 'err', exception: { description: 'detail' } } }))
      .toThrow('detail');
  });
  it('returns undefined for empty result', () => {
    expect(extractValue({ result: {} })).toBeUndefined();
  });
});
