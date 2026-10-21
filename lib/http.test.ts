import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientIp } from './http';

const request = (forwarded?: string) =>
  new Request('http://127.0.0.1:3000/api/auth/login', {
    method: 'POST',
    headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
  });

describe('clientIp', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('ignores addresses the client prepended before the proxy', () => {
    expect(clientIp(request('1.1.1.1, 203.0.113.9'))).toBe('203.0.113.9');
    expect(clientIp(request('203.0.113.9'))).toBe('203.0.113.9');
  });

  it('skips the configured number of trusted proxies', () => {
    vi.stubEnv('TRUSTED_PROXY_HOPS', '2');
    expect(clientIp(request('1.1.1.1, 203.0.113.9, 10.0.0.2'))).toBe(
      '203.0.113.9',
    );
  });

  it('falls back when no proxy reported an address', () => {
    expect(clientIp(request())).toBe('unknown');
  });
});
