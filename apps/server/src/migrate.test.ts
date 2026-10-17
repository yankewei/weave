import { describe, expect, it } from 'vitest';
import { migrationChecksum } from './migrate.js';

describe('migration checksums', () => {
  it('is stable for the same SQL and changes with the content', () => {
    expect(migrationChecksum('SELECT 1;')).toBe(migrationChecksum('SELECT 1;'));
    expect(migrationChecksum('SELECT 1;')).not.toBe(
      migrationChecksum('SELECT 2;'),
    );
  });
});
