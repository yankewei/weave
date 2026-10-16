import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from './index.js';

describe('health response contract', () => {
  it('accepts the API liveness response', () => {
    expect(
      healthResponseSchema.parse({ status: 'ok', service: 'weave-api' }),
    ).toEqual({ status: 'ok', service: 'weave-api' });
  });

  it.each([
    null,
    {},
    { status: 'ok' },
    { status: 'error', service: 'weave-api' },
  ])('rejects an invalid response: %j', (response) => {
    expect(healthResponseSchema.safeParse(response).success).toBe(false);
  });
});
