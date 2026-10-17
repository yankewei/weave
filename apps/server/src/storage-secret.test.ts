import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageSecretBox } from './storage-secret.js';

describe('StorageSecretBox', () => {
  const box = new StorageSecretBox();
  const key = Buffer.alloc(32, 3).toString('base64');

  beforeEach(() => {
    vi.stubEnv('STORAGE_ENCRYPTION_KEY', key);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('round-trips a secret with authenticated encryption', () => {
    const encrypted = box.encrypt('secret-key');
    expect(encrypted).toMatch(/^v1\./);
    expect(encrypted).not.toContain('secret-key');
    expect(box.decrypt(encrypted)).toBe('secret-key');
    expect(box.encrypt('secret-key')).not.toBe(encrypted);
  });

  it('encrypts a maximum-length secret beyond the old column limit', () => {
    const plaintext = 's'.repeat(256);
    const encrypted = box.encrypt(plaintext);
    expect(encrypted.length).toBeGreaterThan(256);
    expect(box.decrypt(encrypted)).toBe(plaintext);
  });

  it('rejects tampered ciphertext and malformed envelopes', () => {
    const encrypted = box.encrypt('secret-key');
    const parts = encrypted.split('.');
    parts[3] = (parts[3]!.startsWith('A') ? 'B' : 'A') + parts[3]!.slice(1);
    expect(() => box.decrypt(parts.join('.'))).toThrow();
    expect(() => box.decrypt('v1.not-an-envelope')).toThrow(
      'Invalid encrypted storage secret.',
    );
  });

  it('keeps legacy plaintext readable and re-encrypts it on save', () => {
    expect(box.decrypt('legacy-secret')).toBe('legacy-secret');
    const upgraded = box.encryptIfNeeded('legacy-secret');
    expect(upgraded).toMatch(/^v1\./);
    expect(box.decrypt(upgraded)).toBe('legacy-secret');
    expect(box.encryptIfNeeded(upgraded)).toBe(upgraded);
  });

  it('requires a valid 32-byte base64 key', () => {
    vi.stubEnv('STORAGE_ENCRYPTION_KEY', '');
    expect(() => box.encrypt('secret-key')).toThrow(
      ServiceUnavailableException,
    );
    vi.stubEnv('STORAGE_ENCRYPTION_KEY', Buffer.alloc(16).toString('base64'));
    expect(() => box.encrypt('secret-key')).toThrow(
      ServiceUnavailableException,
    );
  });
});
