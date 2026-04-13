import { describe, it, expect, afterEach } from 'vitest';
import { resolveEnv } from '../src/agent/tools.js';

describe('resolveEnv', () => {
  afterEach(() => {
    delete process.env.TEST_VAR;
  });
  it('resolves $VAR from process.env', () => {
    process.env.TEST_VAR = 'hello';
    expect(resolveEnv('$TEST_VAR')).toBe('hello');
  });
  it('resolves ${VAR} from process.env', () => {
    process.env.TEST_VAR = 'world';
    expect(resolveEnv('${TEST_VAR}')).toBe('world');
  });
  it('returns original when var not found', () => {
    expect(resolveEnv('$NONEXISTENT_XYZ')).toBe('$NONEXISTENT_XYZ');
  });
  it('resolves multiple vars', () => {
    process.env.TEST_VAR = 'a';
    expect(resolveEnv('$TEST_VAR and $TEST_VAR')).toBe('a and a');
  });
  it('passes through plain strings', () => {
    expect(resolveEnv('hello world')).toBe('hello world');
  });
});
