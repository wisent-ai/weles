import { describe, it, expect } from 'vitest';
import { CDPError, CDPTimeoutError, CDPNavigationError, CDPTargetClosedError } from '../src/cdp/errors.js';

describe('CDPError hierarchy', () => {
  it('CDPError has correct name', () => {
    const e = new CDPError('test');
    expect(e.name).toBe('CDPError');
    expect(e.message).toBe('test');
    expect(e instanceof Error).toBe(true);
  });
  it('CDPTimeoutError extends CDPError', () => {
    const e = new CDPTimeoutError();
    expect(e instanceof CDPError).toBe(true);
    expect(e.name).toBe('CDPTimeoutError');
    expect(e.message).toBe('Timeout');
  });
  it('CDPNavigationError extends CDPError', () => {
    const e = new CDPNavigationError('nav failed');
    expect(e instanceof CDPError).toBe(true);
    expect(e.name).toBe('CDPNavigationError');
    expect(e.message).toBe('nav failed');
  });
  it('CDPTargetClosedError has default message', () => {
    const e = new CDPTargetClosedError();
    expect(e instanceof CDPError).toBe(true);
    expect(e.message).toBe('Target closed');
  });
  it('CDPTargetClosedError accepts custom message', () => {
    const e = new CDPTargetClosedError('custom');
    expect(e.message).toBe('custom');
  });
});
