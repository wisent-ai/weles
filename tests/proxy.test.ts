import { describe, it, expect } from 'vitest';
import { proxyUrl, toPlaywright, parseProxyUrl, ProxyPool, resolveProxy } from '../src/proxy/config.js';

describe('proxyUrl', () => {
  it('builds URL with auth', () => {
    expect(proxyUrl({ host: 'proxy.io', port: 8080, username: 'u', password: 'p', protocol: 'http' }))
      .toBe('http://u:p@proxy.io:8080');
  });
  it('builds URL without auth', () => {
    expect(proxyUrl({ host: 'proxy.io', port: 3128, protocol: 'socks5' }))
      .toBe('socks5://proxy.io:3128');
  });
  it('encodes special chars in auth', () => {
    const url = proxyUrl({ host: 'h', port: 1, username: 'a@b', password: 'c:d', protocol: 'http' });
    expect(url).toContain('a%40b');
    expect(url).toContain('c%3Ad');
  });
});

describe('toPlaywright', () => {
  it('includes server and credentials', () => {
    const r = toPlaywright({ host: 'h', port: 80, username: 'u', password: 'p', protocol: 'http' });
    expect(r.server).toBe('http://h:80');
    expect(r.username).toBe('u');
    expect(r.password).toBe('p');
  });
  it('omits credentials when absent', () => {
    const r = toPlaywright({ host: 'h', port: 80, protocol: 'http' });
    expect(r.username).toBeUndefined();
    expect(r.password).toBeUndefined();
  });
});

describe('parseProxyUrl', () => {
  it('parses http URL with auth', () => {
    const c = parseProxyUrl('http://user:pass@host.com:3128');
    expect(c.protocol).toBe('http');
    expect(c.host).toBe('host.com');
    expect(c.port).toBe(3128);
    expect(c.username).toBe('user');
    expect(c.password).toBe('pass');
  });
  it('parses socks5 URL without auth', () => {
    const c = parseProxyUrl('socks5://127.0.0.1:1080');
    expect(c.protocol).toBe('socks5');
    expect(c.username).toBeUndefined();
  });
  it('round-trips through proxyUrl', () => {
    const original = { host: 'px.io', port: 7777, username: 'u', password: 'p', protocol: 'http' as const };
    const parsed = parseProxyUrl(proxyUrl(original));
    expect(parsed.host).toBe(original.host);
    expect(parsed.port).toBe(original.port);
    expect(parsed.username).toBe(original.username);
  });
});

describe('ProxyPool', () => {
  it('round-robins', () => {
    const pool = new ProxyPool();
    pool.add({ host: 'a', port: 1, protocol: 'http' });
    pool.add({ host: 'b', port: 2, protocol: 'http' });
    expect(pool.next().host).toBe('a');
    expect(pool.next().host).toBe('b');
    expect(pool.next().host).toBe('a');
  });
  it('throws on empty pool', () => {
    expect(() => new ProxyPool().next()).toThrow('empty');
  });
  it('tracks length', () => {
    const pool = new ProxyPool();
    expect(pool.length).toBe(0);
    pool.add({ host: 'a', port: 1, protocol: 'http' });
    expect(pool.length).toBe(1);
  });
});

describe('resolveProxy URL policy', () => {
  it('rejects retired URL-form proxy hosts and ports', async () => {
    await expect(resolveProxy('http://user:pass@isp.oxylabs.io:8003', 'www.linkedin.com')).resolves.toBeUndefined();
    await expect(resolveProxy('http://user:pass@proxy.example.test:7777', 'www.linkedin.com')).resolves.toBeUndefined();
  });

  it('marks accepted URL-form proxies as unclassified', async () => {
    await expect(resolveProxy('http://user:pass@proxy.example.test:8001', 'www.linkedin.com'))
      .resolves.toMatchObject({ proxy_type: 'url_unclassified' });
  });
});
