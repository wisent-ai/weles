import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../src/session/store.js';

let dir: string;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weles-session-test-'));
  store = new SessionStore(join(dir, 'sessions.json'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('SessionStore', () => {
  it('saves and loads cookies', () => {
    const cookies = [{ name: 'sid', value: 'abc', domain: '.example.com', path: '/' }];
    store.saveCookies('test', cookies);
    const loaded = store.loadCookies('test');
    expect(loaded).toEqual(cookies);
  });
  it('returns null for unknown label', () => {
    expect(store.loadCookies('missing')).toBeNull();
  });
  it('keeps labels independent', () => {
    store.saveCookies('a', [{ name: 'x', value: '1' }]);
    store.saveCookies('b', [{ name: 'y', value: '2' }]);
    expect(store.loadCookies('a')![0].name).toBe('x');
    expect(store.loadCookies('b')![0].name).toBe('y');
  });
  it('persists across instances', () => {
    store.saveCookies('persist', [{ name: 'z', value: '9' }]);
    const store2 = new SessionStore(join(dir, 'sessions.json'));
    expect(store2.loadCookies('persist')![0].value).toBe('9');
  });
});
